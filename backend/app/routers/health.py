"""Production health probes (Phase 3): liveness + readiness."""
from __future__ import annotations

import time

from fastapi import APIRouter
from sqlalchemy import text

router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("/liveness")
async def liveness() -> dict:
    """Immediate 200 — the web process is responsive."""
    return {"status": "alive"}


@router.get("/readiness")
async def readiness() -> dict:
    """DB query latency + Redis ping + Celery worker ping. 503 if any fail."""
    from app.config import settings
    from app.database import engine

    checks: dict[str, str] = {}
    ok = True

    t0 = time.perf_counter()
    try:
        async with engine.connect() as conn:
            await conn.scalar(text("SELECT 1"))
        checks["database"] = f"ok ({int((time.perf_counter() - t0) * 1000)}ms)"
    except Exception as exc:  # noqa: BLE001
        ok = False
        checks["database"] = f"fail: {exc}"

    try:
        import redis.asyncio as aioredis

        r = aioredis.from_url(settings.REDIS_URL)
        try:
            t0 = time.perf_counter()
            await r.ping()
            checks["redis"] = f"ok ({int((time.perf_counter() - t0) * 1000)}ms)"
        finally:
            await r.aclose()
    except Exception as exc:  # noqa: BLE001
        ok = False
        checks["redis"] = f"fail: {exc}"

    try:
        from app.tasks.worker import celery_app

        pong = celery_app.control.ping(timeout=2)
        checks["celery"] = "ok" if pong else "no workers responding"
        if not pong:
            ok = False
    except Exception as exc:  # noqa: BLE001
        ok = False
        checks["celery"] = f"fail: {exc}"

    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=200 if ok else 503,
                        content={"status": "ready" if ok else "degraded", "checks": checks})
