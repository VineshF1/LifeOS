"""Data transparency + full account purge (Phase 3, V2-native deps).

Checkpoint purge matches BOTH thread_id formats: raw str(user_id) (stateless
loop.py path, which never namespaced) and the f"{user_id}:{session_id}" /
f"{user_id}:{action_id}" namespaced form (graph.py run_graph_turn).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import get_tenant_session_with_email
from ..security import CurrentUser, get_current_user

router = APIRouter(tags=["privacy"])


@router.get("/privacy/transparency-log")
async def transparency_log(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> dict:
    docs = await session.scalar(
        text("SELECT COUNT(*) FROM documents WHERE user_id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user.id)},
    )
    chunks = await session.scalar(
        text("SELECT COUNT(*) FROM document_chunks WHERE user_id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user.id)},
    )
    audits = await session.scalar(
        text("SELECT COUNT(*) FROM audit_logs WHERE user_id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user.id)},
    )
    return {
        "stored_in_postgres": {
            "account_metadata": ["email", "subscription_tier"],
            "documents": int(docs or 0),
            "chunks_vectors": int(chunks or 0),
            "audit_logs": int(audits or 0),
            "isolation": "tenant-isolated tables guarded by RLS (app.current_user_id)",
        },
        "sent_to_nvidia_nim": {
            "what": "untrusted text chunks for embeddings + entity extraction (transient API requests)",
            "retention": "zero model-training retention",
            "models": [settings.LLM_MODEL, settings.EMBEDDING_MODEL],
        },
    }


@router.post("/user/purge-account")
async def purge_account(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> dict:
    uid = str(user.id)
    # LangGraph checkpoints live in the checkpointer tables (checkpoints /
    # checkpoint_writes / checkpoint_blobs in langgraph-checkpoint-postgres 2.x).
    # Probe existence first: a failed DELETE would abort the request transaction.
    for table in ("checkpoints", "checkpoint_writes", "checkpoint_blobs"):
        exists = await session.scalar(
            text("SELECT to_regclass(:t)"), {"t": f"public.{table}"}
        )
        if exists is None:
            continue
        await session.execute(
            text(f"DELETE FROM {table} WHERE thread_id = :uid OR thread_id LIKE :prefix"),
            {"uid": uid, "prefix": f"{uid}:%"},
        )
    for table in ("document_chunks", "documents", "tasks", "document_shares",
                  "notifications", "pending_actions", "audit_logs"):
        await session.execute(
            text(f"DELETE FROM {table} WHERE user_id = CAST(CAST(:uid AS text) AS uuid)"),
            {"uid": uid},
        )
    await session.execute(
        text("DELETE FROM users WHERE id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": uid},
    )
    try:  # invalidate cached session tokens
        import redis.asyncio as aioredis

        r = aioredis.from_url(settings.REDIS_URL)
        try:
            async for key in r.scan_iter(f"session:{uid}:*"):
                await r.delete(key)
        finally:
            await r.aclose()
    except Exception:
        pass
    return {"status": "purged", "user_id": uid}
