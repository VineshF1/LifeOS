"""Notifications: list, mark-read, and the SSE live feed (Phase 2)."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from ..database import AsyncSessionLocal, get_tenant_session, set_tenant_context
from ..schemas import NotificationOut
from ..security import CurrentUser, decode_access_token, get_current_user
from ..services.notifications import expire_pending_actions, notification_event_stream, sync_deadline_notifications

router = APIRouter(prefix="/notifications", tags=["notifications"])


def _notification_out(row) -> NotificationOut:
    return NotificationOut(
        id=row["id"], title=row["title"], message=row["message"], type=row["type"] or "deadline",
        is_read=bool(row["is_read"]), due_date=row["due_date"], created_at=row["created_at"],
    )


@router.get("", response_model=list[NotificationOut])
async def list_notifications(
    unread_only: bool = Query(False),
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> list[NotificationOut]:
    await expire_pending_actions(session)
    await sync_deadline_notifications(session, user.id)
    where = "user_id = CAST(CAST(:uid AS text) AS uuid)" + (" AND is_read = FALSE" if unread_only else "")
    rows = (
        await session.execute(
            text(
                f"""SELECT id, title, message, type, is_read, due_date, created_at
                    FROM notifications WHERE {where} ORDER BY created_at DESC LIMIT 100"""
            ),
            {"uid": str(user.id)},
        )
    ).mappings().all()
    return [_notification_out(row) for row in rows]


@router.patch("/{notification_id}/read", response_model=NotificationOut)
async def mark_read(
    notification_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> NotificationOut:
    row = (
        await session.execute(
            text(
                """UPDATE notifications SET is_read = TRUE
                   WHERE id = CAST(CAST(:nid AS text) AS uuid)
                   RETURNING id, title, message, type, is_read, due_date, created_at"""
            ),
            {"nid": str(notification_id)},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
    return _notification_out(row)


@router.get("/stream")
async def notification_stream(token: str = Query(...)):
    """Live feed for deadline/share/system alerts (EventSource; token in query)."""
    try:
        payload = decode_access_token(token)
        user_id = UUID(str(payload["sub"]))
        email = str(payload.get("email", ""))
    except Exception as exc:  # noqa: BLE001 - bad token is a clean 401-shaped close
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.") from exc

    class _TenantSession:
        """Async context manager yielding a committed tenant-pinned session."""

        def __init__(self):
            self.session = AsyncSessionLocal()

        async def __aenter__(self):
            await self.session.__aenter__()
            await self.session.begin().__aenter__()
            await set_tenant_context(self.session, user_id, email)
            return self.session

        async def __aexit__(self, *args):
            try:
                await self.session.commit()
            finally:
                await self.session.close()

    async def _gen():
        async for frame in notification_event_stream(_TenantSession, user_id):
            event, _, data = frame.partition("\ndata: ")
            yield {"event": event.replace("event: ", "").strip(), "data": data.strip()}

    return EventSourceResponse(_gen())


@router.get("/live")
async def worker_event_live(token: str = Query(...)):
    """Phase 3: Redis Pub/Sub -> SSE bridge for Celery worker events.

    Emits document_status / document_failed frames published by the ingestion
    pipeline (see services/notifications.publish_progress). Chat streaming is
    NOT routed here — it stays in-process on /chat/stream.
    """
    import asyncio
    import json as _json

    try:
        payload = decode_access_token(token)
        user_id = str(payload["sub"])
    except Exception as exc:  # noqa: BLE001 - bad token is a clean 401-shaped close
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.") from exc

    async def _gen():
        from ..services.notifications import listen_user_channel

        yield {"event": "ready", "data": _json.dumps({"live": True})}
        try:
            async for event in listen_user_channel(user_id):
                yield {"event": event.get("type", "worker_event"),
                       "data": _json.dumps(event, default=str)}
        except asyncio.CancelledError:
            pass

    return EventSourceResponse(_gen(), ping=15)


@router.delete("/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_notification(
    notification_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session),
) -> Response:
    result = await session.execute(
        text("DELETE FROM notifications WHERE id = CAST(CAST(:nid AS text) AS uuid)"),
        {"nid": str(notification_id)},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
