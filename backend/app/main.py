"""FastAPI application: CORS, routers, and centralised exception handling.

External inference failures are translated here into clean JSON responses, so
no upstream timeout can surface as an HTML 500 or leave a request hanging.

Phase 3 additions: advisory-locked migration runner (4 uvicorn workers must
not race DDL at boot), correlation-ID middleware, SlowAPI Redis rate limiting,
and the health / privacy / actions routers.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

if sys.platform == "win32":
    # psycopg (LangGraph checkpointer) cannot run on the default
    # ProactorEventLoop. Set before uvicorn creates the loop (import time);
    # asyncpg works on either loop, so nothing else is affected.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .agent.graph import aclose_checkpointer
from .config import settings
from .database import engine
from .nim import NIMTimeoutError, NIMUnavailableError, close_client
from .routers import auth, billing, chat, documents, notifications, pending_actions, tasks
from .routers import actions, health, privacy
from .security.audit import logger as audit_logger

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("lifeos")

_MIGRATION_LOCK_KEY = 482913


async def _run_migrations() -> None:
    """Apply schema.sql + phase2.sql + phase3.sql under a pg_advisory_lock.

    With --workers 4, every worker boots this lifespan concurrently; without
    the lock they race the same DDL (duplicate constraint errors, partial
    policy states). The lock serialises them; migrations are idempotent so
    replays are no-ops. Uses asyncpg directly (same as init_db.py) — the
    pooled SQLAlchemy connection cannot reliably run multi-statement scripts.
    """
    from .database import normalize_database_url

    backend_dir = Path(__file__).resolve().parent.parent
    scripts = [backend_dir / "schema.sql",
               backend_dir / "migrations" / "phase2.sql",
               backend_dir / "migrations" / "phase3.sql"]
    try:
        import asyncpg

        dsn, connect_args = normalize_database_url(settings.DATABASE_URL)
        dsn = dsn.replace("postgresql+asyncpg://", "postgresql://", 1)
        connection = await asyncpg.connect(dsn, **connect_args)
        try:
            await connection.execute(f"SELECT pg_advisory_lock({_MIGRATION_LOCK_KEY})")
            try:
                for script in scripts:
                    if not script.exists():
                        continue
                    await connection.execute(script.read_text(encoding="utf-8"))
                    logger.info("Migration applied: %s", script.name)
            finally:
                await connection.execute(f"SELECT pg_advisory_unlock({_MIGRATION_LOCK_KEY})")
        finally:
            await connection.close()
    except Exception as exc:  # noqa: BLE001 - the API must still boot
        logger.error("Migration runner failed (%s). Run: python -m app.init_db", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.validate_billing()  # fail-loud on half-configured Razorpay keys
    await _run_migrations()
    await _verify_database()
    yield
    await close_client()
    await aclose_checkpointer()
    await engine.dispose()
    try:
        from .database import celery_engine

        await celery_engine.dispose()
    except Exception:  # noqa: BLE001
        pass


async def _verify_database() -> None:
    """Log database health at startup without preventing the app from serving."""
    try:
        async with engine.connect() as connection:
            vector_version = await connection.scalar(
                text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            )
            has_tables = await connection.scalar(text("SELECT to_regclass('public.documents')"))
        if vector_version is None:
            logger.error("pgvector is not installed. Run: python -m app.init_db")
        elif has_tables is None:
            logger.error("Schema missing. Run: python -m app.init_db")
        else:
            logger.info("Database ready (pgvector %s).", vector_version)
    except Exception as exc:  # noqa: BLE001 - the API must still boot
        logger.error("Database unreachable at startup (%s). Run: python -m app.init_db", exc)


app = FastAPI(
    title="LifeOS Agent API",
    version="2.0.0",
    description="Privacy-first personal document and life management agent.",
    lifespan=lifespan,
)


@app.middleware("http")
async def correlation_middleware(request: Request, call_next):
    cid = request.headers.get("X-Correlation-ID") or str(uuid.uuid4())
    request.state.correlation_id = cid
    # Lightweight user hint for per-user rate-limit buckets (auth still
    # enforced by route dependencies; this only keys the bucket).
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        try:
            from .security import decode_access_token

            request.state.user_id = str(decode_access_token(auth[7:]).get("sub"))
        except Exception:  # noqa: BLE001 - invalid token falls back to IP bucket
            pass
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Correlation-ID"] = cid
    audit_logger.info("http_request", path=request.url.path,
                      status=response.status_code,
                      duration_ms=int((time.perf_counter() - started) * 1000))
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(NIMTimeoutError)
async def _handle_nim_timeout(request: Request, exc: NIMTimeoutError) -> JSONResponse:
    logger.warning("NIM timeout on %s", request.url.path)
    return JSONResponse(status_code=504, content={"status": "error", "message": str(exc)})


@app.exception_handler(NIMUnavailableError)
async def _handle_nim_unavailable(request: Request, exc: NIMUnavailableError) -> JSONResponse:
    logger.error("NIM unavailable on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=502,
        content={"status": "error", "message": f"AI service unavailable: {exc}"},
    )


@app.exception_handler(Exception)
async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"status": "error", "message": "An unexpected server error occurred."},
    )


app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(chat.router)
app.include_router(tasks.router)
app.include_router(billing.router)
app.include_router(notifications.router)
app.include_router(pending_actions.router)
app.include_router(actions.router)
app.include_router(health.router)
app.include_router(privacy.router, prefix="/api")


@app.get("/health", tags=["meta"])
async def health() -> dict:
    from .agent.graph import HAS_LANGGRAPH

    return {
        "status": "ok",
        "llm_model": settings.LLM_MODEL,
        "embedding_model": settings.EMBEDDING_MODEL,
        "embedding_dim": settings.EMBEDDING_DIM,
        "agent_max_iterations": settings.AGENT_MAX_ITERATIONS,
        "agents_configured": bool(settings.NVIDIA_API_KEY),
        "langgraph": HAS_LANGGRAPH,
        "free_document_limit": settings.FREE_DOCUMENT_LIMIT,
        "razorpay_configured": bool(settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET),
    }


@app.get("/", tags=["meta"])
async def root() -> dict:
    return {
        "service": "LifeOS Agent API",
        "docs": "/docs",
        "endpoints": [
            "POST /auth/signup",
            "POST /auth/login",
            "GET  /auth/me",
            "POST /documents/upload",
            "POST /documents/upload-async",
            "GET  /documents",
            "GET  /documents/{id}",
            "DELETE /documents/{id}",
            "POST /documents/{id}/share",
            "GET  /documents/{id}/shares",
            "DELETE /documents/shares/{share_id}",
            "POST /chat",
            "POST /chat/stream",
            "GET  /tasks",
            "PATCH /tasks/{id}",
            "GET  /tasks/{id}/calendar",
            "GET  /pending-actions",
            "POST /pending-actions/{id}/decide",
            "GET  /notifications",
            "GET  /notifications/stream",
            "GET  /billing/status",
            "POST /billing/create-checkout-session",
            "POST /billing/webhook",
            "GET  /api/health/liveness",
            "GET  /api/health/readiness",
            "GET  /api/privacy/transparency-log",
            "POST /api/user/purge-account",
        ],
    }
