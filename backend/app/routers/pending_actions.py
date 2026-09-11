"""Human-in-the-loop approvals for drafted agent actions (Phase 2).

Flow: agent calls `propose_task_action` → row in `pending_actions` (pending)
→ UI shows ApprovalModal → user approves/rejects here → on approve the real
action executes (task created), row flips to approved/rejected.

When LangGraph is installed the graph's interrupted thread is also resumed
via Command(resume=...) so orchestrated state continues; otherwise the table
alone drives the flow (it is the source of truth either way).
"""
from __future__ import annotations

import json
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent.tools import ToolContext, create_task
from ..database import get_tenant_session_with_email, record_audit
from ..schemas import PendingActionDecision, PendingActionOut
from ..security import CurrentUser, get_current_user
from ..services.notifications import expire_pending_actions

logger = logging.getLogger("lifeos.approvals")

router = APIRouter(prefix="/pending-actions", tags=["approvals"])


def _pending_out(row) -> PendingActionOut:
    payload = row["payload"]
    if not isinstance(payload, dict):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            payload = {}
    return PendingActionOut(
        id=row["id"], action_type=row["action_type"], payload=payload,
        status=row["status"], created_at=row["created_at"], expires_at=row["expires_at"],
    )


@router.get("", response_model=list[PendingActionOut])
async def list_pending(
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> list[PendingActionOut]:
    await expire_pending_actions(session)
    rows = (
        await session.execute(
            text(
                """SELECT id, action_type, payload, status, created_at, expires_at
                   FROM pending_actions
                   WHERE user_id = CAST(CAST(:uid AS text) AS uuid) AND status = 'pending'
                   ORDER BY created_at DESC"""
            ),
            {"uid": str(user.id)},
        )
    ).mappings().all()
    return [_pending_out(row) for row in rows]


@router.post("/{action_id}/decide", response_model=PendingActionOut)
async def decide_action(
    action_id: UUID,
    payload: PendingActionDecision,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> PendingActionOut:
    row = (
        await session.execute(
            text(
                """SELECT id, action_type, payload, status, created_at, expires_at
                   FROM pending_actions WHERE id = CAST(CAST(:aid AS text) AS uuid)"""
            ),
            {"aid": str(action_id)},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pending action not found.")
    if row["status"] != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"Action is already {row['status']}."
        )

    data = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"])
    new_status = "approved" if payload.decision == "approve" else "rejected"

    if payload.decision == "approve":
        if row["action_type"] == "create_task":
            result = await create_task(
                ToolContext(session=session, user_id=user.id, user_email=user.email),
                title=str(data.get("title", "Untitled task")),
                due_date=data.get("due_date"),
                source_document_id=data.get("source_document_id"),
            )
            if "error" in result:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=result["error"])
            data["created_task_id"] = result["task_id"]
        else:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Unknown action_type '{row['action_type']}'.",
            )

    updated = (
        await session.execute(
            text(
                """UPDATE pending_actions SET status = :status,
                          payload = CAST(CAST(:payload AS text) AS jsonb)
                   WHERE id = CAST(CAST(:aid AS text) AS uuid)
                   RETURNING id, action_type, payload, status, created_at, expires_at"""
            ),
            {"status": new_status, "payload": json.dumps(data, default=str), "aid": str(action_id)},
        )
    ).mappings().one()
    await record_audit(
        session, user.id, "approval_decision",
        input_payload={"action_id": str(action_id), "decision": payload.decision},
        output_payload={"status": new_status},
    )

    # Resume an interrupted LangGraph thread if one is waiting on this action.
    try:
        from ..agent.graph import HAS_LANGGRAPH, run_graph_turn

        if HAS_LANGGRAPH:
            ctx = ToolContext(session=session, user_id=user.id, user_email=user.email)
            await run_graph_turn(
                ctx=ctx, message="", tier="pro",
                thread_id=f"{user.id}:{action_id}", resume=payload.decision,
            )
    except RuntimeError:
        pass  # no graph installed or no thread waiting — table state is enough
    except Exception:  # noqa: BLE001 - approval already committed; never fail it
        logger.exception("Graph resume after approval failed (non-fatal)")

    return _pending_out(updated)
