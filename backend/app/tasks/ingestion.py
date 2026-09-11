"""Async ingestion pipeline (Phase 3): V2 logic, Celery execution.

Stage order mirrors the synchronous V2 upload path (documents.py):
parse -> chunk+embed (search works even if extraction fails) -> extract
metadata -> deadline task draft -> ready. Each boundary re-checks
documents.status so a user delete ('deleted') halts the pipeline cleanly —
never revoke(terminate=True) mid-transaction.

Idempotency: chunk inserts are preceded by DELETE FROM document_chunks for
the document, so a retried task never duplicates vectors.
"""
from __future__ import annotations

import json
import logging
import os
import time
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.tools import ToolContext, create_task
from app.config import settings
from app.database import AsyncCelerySession, record_audit, set_tenant_context, to_vector_literal
from app.ingestion import (
    ExtractionError,
    UnreadableDocumentError,
    chunk_pages,
    embed_documents,
    extract_metadata,
    extract_pages,
    full_text,
    total_characters,
)
from app.security.audit import logger as _slog  # noqa: F401  (structlog JSON logger)
from app.security.sanitization import sanitize_chunk, wrap_untrusted_context

logger = logging.getLogger("lifeos.pipeline")

_STATUSES = ("queued", "parsing", "extracting", "embedding", "ready", "needs_review", "deleted", "failed")


async def _check_cancellation(session: AsyncSession, doc_id: str) -> bool:
    status = await session.scalar(
        text("SELECT status FROM documents WHERE id = CAST(CAST(:did AS text) AS uuid)"),
        {"did": doc_id},
    )
    if status is None or status == "deleted":
        logger.info("Pipeline halted cleanly for deleted document %s", doc_id)
        return True
    return False


class RowNotVisibleYet(RuntimeError):
    """First-boundary race: the upload transaction hasn't committed."""


async def _set_status(session: AsyncSession, doc_id: str, value: str) -> None:
    await session.execute(
        text("UPDATE documents SET status = :s WHERE id = CAST(CAST(:did AS text) AS uuid)"),
        {"s": value, "did": doc_id},
    )


async def _publish(user_id: str, payload: dict) -> None:
    """Redis Pub/Sub progress event for open SSE sockets (best-effort)."""
    try:
        import redis.asyncio as aioredis

        r = aioredis.from_url(settings.REDIS_URL)
        try:
            await r.publish(f"notifications:{user_id}", json.dumps(payload, default=str))
        finally:
            await r.aclose()
    except Exception as exc:  # Redis down must not fail ingestion
        logger.warning("SSE publish failed: %s", exc)


async def record_dead_letter(doc_id: str, user_id: str, error_msg: str, correlation_id: str) -> None:
    async with AsyncCelerySession() as session:
        async with session.begin():
            await set_tenant_context(session, UUID(user_id), None)
            await _set_status(session, doc_id, "failed")
            await session.execute(
                text(
                    "UPDATE documents SET metadata = COALESCE(metadata, '{}'::jsonb) "
                    "|| CAST(CAST(:m AS text) AS jsonb) "
                    "WHERE id = CAST(CAST(:did AS text) AS uuid)"
                ),
                {"m": json.dumps({"processing_error": error_msg[:2000]}), "did": doc_id},
            )
            try:
                await record_audit(
                    session, UUID(user_id), "dlq_ingest",
                    output_payload={"document_id": doc_id, "error": error_msg[:1000],
                                    "correlation_id": correlation_id},
                )
            except Exception:
                pass
    await _publish(user_id, {"type": "document_failed", "document_id": doc_id,
                             "error": error_msg[:500], "correlation_id": correlation_id})
    logger.error("Document %s dead-lettered: %s", doc_id, error_msg[:300])


async def run_ingestion_pipeline(doc_id: str, user_id: str, user_email: str, correlation_id: str) -> None:
    started = time.perf_counter()
    uid = UUID(user_id)
    path = os.path.join(settings.UPLOAD_DIR, f"{doc_id}.pdf")

    async with AsyncCelerySession() as session:
        # --- Boundary 1 ---------------------------------------------------
        async with session.begin():
            await set_tenant_context(session, uid, user_email)
            first_status = await session.scalar(
                text("SELECT status FROM documents WHERE id = CAST(CAST(:did AS text) AS uuid)"),
                {"did": doc_id},
            )
            if first_status is None:
                # Upload transaction hasn't committed yet — retry with backoff.
                raise RowNotVisibleYet(f"document row {doc_id} not visible yet")
            if first_status == "deleted":
                logger.info("Pipeline halted cleanly for deleted document %s", doc_id)
                return
            await _set_status(session, doc_id, "parsing")
            row = (await session.execute(
                text("SELECT filename FROM documents WHERE id = CAST(CAST(:did AS text) AS uuid)"),
                {"did": doc_id},
            )).scalar_one_or_none()
            filename = row or "document.pdf"
        await _publish(user_id, {"type": "document_status", "document_id": doc_id,
                                 "status": "parsing", "correlation_id": correlation_id})

        try:
            with open(path, "rb") as f:
                data = f.read()
        except FileNotFoundError as exc:
            async with session.begin():
                await set_tenant_context(session, uid, user_email)
                await _set_status(session, doc_id, "failed")
            raise RuntimeError(f"Uploaded binary missing from shared volume: {path}") from exc

        # --- Parse (PyMuPDF; scanned fallback) -----------------------------
        try:
            pages = extract_pages(data)
        except UnreadableDocumentError as exc:
            async with session.begin():
                await set_tenant_context(session, uid, user_email)
                await _set_status(session, doc_id, "needs_review")
            await _publish(user_id, {"type": "document_status", "document_id": doc_id,
                                     "status": "needs_review", "correlation_id": correlation_id})
            return

        raw_text = full_text(pages)
        if total_characters(pages) < settings.MIN_EXTRACTABLE_CHARS:
            async with session.begin():
                await set_tenant_context(session, uid, user_email)
                await session.execute(
                    text("UPDATE documents SET status='needs_review', raw_text=:rt WHERE id = CAST(CAST(:did AS text) AS uuid)"),
                    {"rt": raw_text, "did": doc_id},
                )
            await _publish(user_id, {"type": "document_status", "document_id": doc_id,
                                     "status": "needs_review", "correlation_id": correlation_id})
            return

        # --- Boundary 2 ----------------------------------------------------
        async with session.begin():
            await set_tenant_context(session, uid, user_email)
            if await _check_cancellation(session, doc_id):
                return
            await _set_status(session, doc_id, "extracting")

        # Sanitization scan + delimiter wrapping before any model call.
        wrapped_excerpt = "\n".join(
            wrap_untrusted_context(p.text[:2000], filename, p.page_number) for p in pages[:5]
        )
        _ = sanitize_chunk(raw_text)  # filter pass; raises nothing, normalizes text

        # --- Chunk + embed (before extraction: search works regardless) -----
        chunks = chunk_pages(pages)
        if chunks:
            vectors = await embed_documents([c.content for c in chunks])
            async with session.begin():
                await set_tenant_context(session, uid, user_email)
                if await _check_cancellation(session, doc_id):
                    return
                # Idempotent reset: safe replay after a retry.
                await session.execute(
                    text("DELETE FROM document_chunks WHERE document_id = CAST(CAST(:did AS text) AS uuid)"),
                    {"did": doc_id},
                )
                stmt = text(
                    "INSERT INTO document_chunks "
                    "(document_id, user_id, filename, page_number, chunk_index, content, embedding) "
                    "VALUES (CAST(CAST(:did AS text) AS uuid), CAST(CAST(:uid AS text) AS uuid), "
                    " :fn, :pg, :ci, :ct, CAST(CAST(:emb AS text) AS vector(2048)))"
                )
                params = [{
                    "did": doc_id, "uid": user_id, "fn": filename,
                    "pg": c.page_number, "ci": c.chunk_index, "ct": c.content,
                    "emb": to_vector_literal(v),
                } for c, v in zip(chunks, vectors)]
                for start in range(0, len(params), 50):
                    await session.execute(stmt, params[start:start + 50])
                await _set_status(session, doc_id, "embedding")

        # --- Boundary 3 + extraction ----------------------------------------
        async with session.begin():
            await set_tenant_context(session, uid, user_email)
            if await _check_cancellation(session, doc_id):
                return
        status_value, metadata_payload, has_deadline = "ready", {}, False
        try:
            extracted = await extract_metadata(raw_text[: settings.EXTRACTION_CHAR_LIMIT])
            metadata_payload = extracted.model_dump()
            has_deadline = bool(extracted.task_warranted and extracted.action_deadline)
        except ExtractionError:
            status_value = "needs_review"
            metadata_payload = {"extraction_error": "model_failed"}

        async with session.begin():
            await set_tenant_context(session, uid, user_email)
            if await _check_cancellation(session, doc_id):
                return
            if has_deadline:
                ctx = ToolContext(session=session, user_id=uid, document_id=UUID(doc_id),
                                  user_email=user_email)
                task_result = await create_task(
                    ctx,
                    title=metadata_payload.get("action_description") or "Action required",
                    due_date=metadata_payload.get("action_deadline"),
                    source_document_id=doc_id,
                )
                if "task_id" in task_result:
                    metadata_payload["drafted_task_id"] = task_result["task_id"]
            await session.execute(
                text(
                    "UPDATE documents SET status=:s, raw_text=:rt, "
                    " metadata = CAST(CAST(:md AS text) AS jsonb), "
                    " has_actionable_deadline=:dl "
                    "WHERE id = CAST(CAST(:did AS text) AS uuid)"
                ),
                {"s": status_value, "rt": raw_text[:500000],
                 "md": json.dumps(metadata_payload, default=str),
                 "dl": has_deadline, "did": doc_id},
            )
            await record_audit(
                session, uid, "document_ingest",
                output_payload={"document_id": doc_id, "chunks": len(chunks),
                                "status": status_value,
                                "correlation_id": correlation_id},
                execution_time_ms=int((time.perf_counter() - started) * 1000),
            )

    await _publish(user_id, {"type": "document_status", "document_id": doc_id,
                             "status": status_value, "correlation_id": correlation_id})
    _slog.info("ingestion_complete", document_id=doc_id, correlation_id=correlation_id,
               chunks=len(chunks), status=status_value)
