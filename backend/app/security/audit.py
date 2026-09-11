"""Phase 3 observability: structlog JSON traces + LLM metrics audit writer.

V2's database.record_audit(session, user_id, action, input_payload=...) stays
the canonical audit path. record_llm_audit() below writes the Phase 3 metric
columns (model_name, prompt/completion tokens, latency, correlation_id) added
by migrations/phase3.sql — call it only after migrations have run (the app
lifespan applies them at boot before serving traffic).
"""
from __future__ import annotations

import time
import uuid
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.JSONRenderer(),
    ]
)
logger = structlog.get_logger("lifeos")


def bind_correlation(correlation_id: str | None = None) -> str:
    cid = correlation_id or str(uuid.uuid4())
    structlog.contextvars.bind_contextvars(correlation_id=cid)
    return cid


async def record_llm_audit(
    session: AsyncSession,
    *,
    user_id: str | None,
    action_type: str,
    tool_name: str | None = None,
    model_name: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    latency_ms: int = 0,
    status: str = "success",
    correlation_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Append-only LLM/tool metric row (never raises into the request path)."""
    import json

    try:
        async with session.begin_nested():
            await session.execute(
                text(
                    "INSERT INTO audit_logs "
                    "(user_id, action_type, tool_name, model_name, prompt_tokens, "
                    " completion_tokens, latency_ms, status, correlation_id, "
                    " input_payload, output_payload) "
                    "VALUES (CAST(CAST(:uid AS text) AS uuid), :action, :tool, :model, "
                    " :pt, :ct, :lat, :status, :cid, "
                    " CAST(CAST(:inp AS text) AS jsonb), CAST(CAST(:out AS text) AS jsonb))"
                ),
                {
                    "uid": user_id,
                    "action": action_type,
                    "tool": tool_name,
                    "model": model_name,
                    "pt": prompt_tokens,
                    "ct": completion_tokens,
                    "lat": latency_ms,
                    "status": status,
                    "cid": correlation_id,
                    "inp": json.dumps({"correlation_id": correlation_id}),
                    "out": json.dumps(details or {}, default=str),
                },
            )
    except Exception:
        logger.exception("Failed to write LLM audit log")


class timed:
    def __init__(self, event: str, **fields: Any):
        self.event = event
        self.fields = fields
        self._t0 = 0.0

    def __enter__(self):
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        ms = int((time.perf_counter() - self._t0) * 1000)
        logger.info(self.event, duration_ms=ms, **self.fields)
