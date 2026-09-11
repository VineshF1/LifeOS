"""Proactive deadline checker + notification helpers + SSE event feed (Phase 2)."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("lifeos.notifications")

DEADLINE_WINDOW_DAYS = 30


async def create_notification(
    session: AsyncSession,
    user_id: UUID,
    title: str,
    message: str,
    *,
    type: str = "deadline",
    due_date: str | None = None,
) -> str:
    row = (
        await session.execute(
            text(
                """
                INSERT INTO notifications (user_id, title, message, type, due_date)
                VALUES (CAST(CAST(:uid AS text) AS uuid), :title, :message, :type,
                        CAST(CAST(:due AS text) AS date))
                RETURNING id::text
                """
            ),
            {"uid": str(user_id), "title": title[:255], "message": message, "type": type, "due": due_date},
        )
    ).scalar_one()
    return str(row)


async def sync_deadline_notifications(session: AsyncSession, user_id: UUID) -> int:
    """Ensure one unread deadline notification per doc expiring within 30 days.

    Returns the number of newly created notifications.
    """
    rows = (
        await session.execute(
            text(
                """
                SELECT id::text AS id, filename, metadata->>'action_deadline' AS deadline,
                       metadata->>'action_description' AS action
                FROM documents
                WHERE user_id = CAST(CAST(:uid AS text) AS uuid)
                  AND metadata->>'action_deadline' IS NOT NULL
                  AND (metadata->>'action_deadline')::date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
                """
            ),
            {"uid": str(user_id)},
        )
    ).mappings().all()
    created = 0
    for row in rows:
        exists = await session.scalar(
            text(
                """
                SELECT 1 FROM notifications
                WHERE user_id = CAST(CAST(:uid AS text) AS uuid)
                  AND type = 'deadline' AND is_read = FALSE
                  AND message LIKE :needle LIMIT 1
                """
            ),
            {"uid": str(user_id), "needle": f"%{row['filename']}%"},
        )
        if exists:
            continue
        await create_notification(
            session,
            user_id,
            f"Expiring soon: {row['filename']}",
            f"{row['action'] or 'Action required'} — {row['filename']} expires {row['deadline']}.",
            type="deadline",
            due_date=row["deadline"],
        )
        created += 1
    return created


async def expire_pending_actions(session: AsyncSession) -> int:
    """Mark rows past `expires_at` as expired (TTL cleanup for approvals)."""
    result = await session.execute(
        text("UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()")
    )
    return int(result.rowcount or 0)


async def unread_count(session: AsyncSession, user_id: UUID) -> int:
    return int(
        await session.scalar(
            text(
                "SELECT COUNT(*) FROM notifications WHERE user_id = CAST(CAST(:uid AS text) AS uuid) AND is_read = FALSE"
            ),
            {"uid": str(user_id)},
        )
        or 0
    )


def sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


async def notification_event_stream(session_factory, user_id: UUID):
    """Yield SSE frames: initial unread state, deadline sync, then heartbeats.

    `session_factory` must be a callable returning an AsyncSession context
    manager (keeps this service independent of request-scoped sessions).
    """
    async with session_factory() as session:
        await expire_pending_actions(session)
        new_deadlines = await sync_deadline_notifications(session, user_id)
        count = await unread_count(session, user_id)
        await session.commit()
    yield sse_event("ready", {"unread": count, "new_deadlines": new_deadlines})
    # Short-lived stream: one live snapshot + heartbeat, then close so server
    # resources are never held indefinitely. The frontend re-polls on focus.
    await asyncio.sleep(15)
    yield sse_event("heartbeat", {"unread": count, "today": date.today().isoformat()})


# ---------------------------------------------------------------------------
# Phase 3: Redis Pub/Sub bridge (Celery completion events -> SSE sockets)
# ---------------------------------------------------------------------------
# The V2 helpers above (deadline sync, notification_event_stream) are unchanged.
# The bridge below carries background worker events; chat streaming itself
# stays in-process per prompt §3.

async def publish_progress(user_id: str, payload: dict) -> None:
    """Publish a worker progress event to notifications:{user_id} (best-effort)."""
    import json as _json

    try:
        import redis.asyncio as _aioredis

        from ..config import settings as _settings

        client = _aioredis.from_url(_settings.REDIS_URL)
        try:
            await client.publish(f"notifications:{user_id}", _json.dumps(payload, default=str))
        finally:
            await client.aclose()
    except Exception:  # noqa: BLE001 - Redis down must not fail callers
        logger.warning("Redis publish failed for user %s", user_id)


async def listen_user_channel(user_id: str):
    """Async generator yielding decoded events from notifications:{user_id}."""
    import json as _json

    import redis.asyncio as _aioredis

    from ..config import settings as _settings

    client = _aioredis.from_url(_settings.REDIS_URL, decode_responses=True)
    pubsub = client.pubsub()
    await pubsub.subscribe(f"notifications:{user_id}")
    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                yield _json.loads(message["data"])
            except (ValueError, TypeError):
                continue
    finally:
        await pubsub.unsubscribe(f"notifications:{user_id}")
        await client.aclose()
