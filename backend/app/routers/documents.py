"""PDF upload, parsing, chunked embedding, metadata extraction, and listing."""
from __future__ import annotations

import json
import logging
import time
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..agent.tools import ToolContext, create_task
from ..config import settings
from ..database import (
    get_current_user_id,
    get_tenant_session,
    get_tenant_session_with_email,
    record_audit,
    to_vector_literal,
)
from ..ingestion import (
    ExtractionError,
    UnreadableDocumentError,
    chunk_pages,
    embed_documents,
    extract_metadata,
    extract_pages,
    full_text,
    total_characters,
)
from ..nim import NIMTimeoutError, NIMUnavailableError
from ..schemas import DocumentListResponse, DocumentOut, ShareCreate, ShareOut, UploadResponse
from ..security import CurrentUser, decode_access_token, get_current_user
from ..security.ratelimit import limit_upload
from ..services.billing import check_tier_limit, get_tier, require_pro
from ..services.notifications import create_notification

logger = logging.getLogger("lifeos.documents")

router = APIRouter(prefix="/documents", tags=["documents"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
PDF_MAGIC = b"%PDF-"


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _as_dict(value: Any) -> dict[str, Any]:
    """Metadata arrives as jsonb; tolerate drivers that hand back raw text."""
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, (str, bytes, bytearray)):
        try:
            parsed = json.loads(value)
        except (json.JSONDecodeError, TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _document_out(row: Any) -> DocumentOut:
    return DocumentOut(
        id=row["id"],
        filename=row["filename"],
        category=row["category"] or "General",
        status=row["status"] or "processing",
        has_actionable_deadline=bool(row["has_actionable_deadline"]),
        metadata=_as_dict(row["metadata"]),
        created_at=row["created_at"],
        chunk_count=int(row["chunk_count"]) if "chunk_count" in row.keys() else 0,
    )


def _safe_filename(raw: str | None) -> str:
    name = (raw or "").replace("\\", "/").split("/")[-1].strip()
    name = "".join(ch for ch in name if ch.isprintable())
    return (name or "document.pdf")[:255]


async def _set_status(session: AsyncSession, document_id: UUID, status_value: str) -> None:
    await session.execute(
        text(
            """UPDATE documents SET status = :status
               WHERE id = CAST(CAST(:document_id AS text) AS uuid)"""
        ),
        {"status": status_value, "document_id": str(document_id)},
    )


# --------------------------------------------------------------------------
# Upload
# --------------------------------------------------------------------------


@router.post("/upload", response_model=UploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(check_tier_limit),
    session: AsyncSession = Depends(get_tenant_session_with_email),
    _: None = Depends(limit_upload),
) -> UploadResponse:
    """Ingest one PDF.

    Free tier is capped at FREE_DOCUMENT_LIMIT uploads (403 via check_tier_limit).
    Returns 200/201 with a document whose `status` may be `needs_review` rather
    than failing the request: a bad file must never break the dashboard.

    Order of operations is deliberate -- chunks are embedded BEFORE extraction,
    so a document whose extraction fails is still fully searchable in chat.
    """
    user_id = user.id
    filename = _safe_filename(file.filename)
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF files are supported."
        )

    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    if PDF_MAGIC not in data[:1024]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="That file is not a valid PDF."
        )

    started = time.perf_counter()
    document_id = uuid4()
    warnings: list[str] = []

    # Persist raw bytes alongside the async path so the in-app viewer
    # (GET /documents/{id}/file) works no matter which upload route ran.
    import os

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    with open(os.path.join(settings.UPLOAD_DIR, f"{document_id}.pdf"), "wb") as fh:
        fh.write(data)

    # Row first, so any later failure still leaves a visible, explainable document.
    await session.execute(
        text(
            """
            INSERT INTO documents (id, user_id, filename, status, raw_text, metadata)
            VALUES (
                CAST(CAST(:id AS text) AS uuid),
                CAST(CAST(:user_id AS text) AS uuid),
                :filename, 'processing', '', CAST(CAST(:metadata AS text) AS jsonb)
            )
            """
        ),
        {"id": str(document_id), "user_id": str(user_id), "filename": filename, "metadata": "{}"},
    )

    # --- 1. Parse ---------------------------------------------------------
    try:
        pages = extract_pages(data)
    except UnreadableDocumentError as exc:
        await _set_status(session, document_id, "needs_review")
        warnings.append(f"{exc} The file was stored but could not be read.")
        await record_audit(
            session,
            user_id,
            "document_upload",
            output_payload={"filename": filename, "error": str(exc)},
            execution_time_ms=int((time.perf_counter() - started) * 1000),
        )
        return UploadResponse(
            document=await _load_document(session, document_id),
            message="Document stored, but its text could not be read.",
            warnings=warnings,
        )

    raw_text = full_text(pages)
    character_count = total_characters(pages)

    if character_count < settings.MIN_EXTRACTABLE_CHARS:
        scanned = any(page.has_images for page in pages)
        if scanned:
            message = (
                "This PDF looks like scanned images with no text layer, so no text "
                "could be extracted. Please upload a searchable PDF (or export/print "
                "the scan to PDF with OCR first)."
            )
            error_code = "scanned_no_text"
        else:
            message = "Document text is unreadable or empty. Please check the file."
            error_code = "insufficient_text"
        await session.execute(
            text(
                """UPDATE documents
                   SET status = 'needs_review', raw_text = :raw_text,
                       metadata = CAST(CAST(:metadata AS text) AS jsonb)
                   WHERE id = CAST(CAST(:document_id AS text) AS uuid)"""
            ),
            {
                "raw_text": raw_text,
                "metadata": json.dumps({"extraction_error": error_code}),
                "document_id": str(document_id),
            },
        )
        warnings.append(message)
        await record_audit(
            session,
            user_id,
            "document_upload",
            output_payload={
                "filename": filename,
                "characters": character_count,
                "scanned": scanned,
            },
            execution_time_ms=int((time.perf_counter() - started) * 1000),
        )
        return UploadResponse(
            document=await _load_document(session, document_id),
            message=message,
            warnings=warnings,
        )

    # --- 2. Chunk + embed (before extraction, so search works regardless) ---
    chunks = chunk_pages(pages)
    chunk_count = 0
    if chunks:
        try:
            vectors = await embed_documents([chunk.content for chunk in chunks])
            await _insert_chunks(session, document_id, user_id, filename, chunks, vectors)
            chunk_count = len(chunks)
        except Exception as exc:  # noqa: BLE001 - upload must survive an embedding outage
            logger.warning("Embedding failed for %s: %s", filename, exc)
            warnings.append(
                "Vector indexing failed, so this document is not yet searchable in chat."
            )

    # --- 3. Structured extraction ----------------------------------------
    status_value = "ready"
    metadata_payload: dict[str, Any] = {}
    has_deadline = False
    extraction_ms = 0

    extraction_started = time.perf_counter()
    try:
        extracted = await extract_metadata(raw_text)
        metadata_payload = extracted.model_dump()
        has_deadline = bool(extracted.task_warranted and extracted.action_deadline)
        if has_deadline:
            task_result = await create_task(
                ToolContext(session=session, user_id=user_id, document_id=document_id, user_email=user.email),
                title=extracted.action_description or f"{extracted.category} action required",
                due_date=extracted.action_deadline,
                source_document_id=str(document_id),
            )
            if "error" in task_result:
                warnings.append(f"Could not draft the task automatically: {task_result['error']}")
                has_deadline = False
            else:
                metadata_payload["drafted_task_id"] = task_result["task_id"]
    except ExtractionError as exc:
        # Both attempts failed: keep the document, flag it for review, and leave
        # it indexed for vector Q&A.
        status_value = "needs_review"
        metadata_payload = {"extraction_error": str(exc)[:500]}
        has_deadline = False
        warnings.append(
            "Automatic field extraction failed. The document is still searchable in chat."
        )
    except (NIMTimeoutError, NIMUnavailableError) as exc:
        # NIM outage/timeout during extraction must not become a 504 for upload.
        # Keep the document searchable and flag for review; user can retry extraction
        # later. This is the correct fallback per Prompt §4 (never 500 the dashboard).
        logger.warning("Extraction NIM error for %s: %s", filename, exc)
        status_value = "needs_review"
        metadata_payload = {"extraction_error": str(exc)[:500], "extraction_timeout": True}
        has_deadline = False
        warnings.append(
            "AI extraction timed out — document is stored and searchable, but fields need review. Please try re-uploading in a moment."
        )
    except Exception as exc:  # noqa: BLE001 - upload must survive any extraction crash
        logger.warning("Unexpected extraction failure for %s: %s", filename, exc, exc_info=True)
        status_value = "needs_review"
        metadata_payload = {"extraction_error": str(exc)[:500]}
        has_deadline = False
        warnings.append(
            "Automatic field extraction failed. The document is still searchable in chat."
        )
    finally:
        extraction_ms = int((time.perf_counter() - extraction_started) * 1000)

    await session.execute(
        text(
            """
            UPDATE documents
            SET status = :status,
                raw_text = :raw_text,
                category = :category,
                metadata = CAST(CAST(:metadata AS text) AS jsonb),
                has_actionable_deadline = :has_deadline
            WHERE id = CAST(CAST(:document_id AS text) AS uuid)
            """
        ),
        {
            "status": status_value,
            "raw_text": raw_text,
            "category": metadata_payload.get("category") or "General",
            "metadata": json.dumps(metadata_payload, default=str),
            "has_deadline": has_deadline,
            "document_id": str(document_id),
        },
    )

    total_ms = int((time.perf_counter() - started) * 1000)
    await session.execute(
        text("UPDATE users SET document_count = (SELECT COUNT(*) FROM documents WHERE user_id = CAST(CAST(:uid AS text) AS uuid)) WHERE id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user_id)},
    )
    await create_notification(
        session, user_id, f"Processed: {filename}",
        f"{filename} is {status_value} with {chunk_count} searchable chunk(s).",
        type="system",
    )
    if has_deadline and metadata_payload.get("action_deadline"):
        await create_notification(
            session, user_id, f"Deadline: {filename}",
            f"{metadata_payload.get('action_description') or 'Action required'} — due {metadata_payload.get('action_deadline')}.",
            type="deadline", due_date=metadata_payload.get("action_deadline"),
        )
    await record_audit(
        session,
        user_id,
        "document_upload",
        output_payload={
            "filename": filename,
            "characters": character_count,
            "chunks": chunk_count,
            "status": status_value,
        },
        execution_time_ms=total_ms,
    )
    await record_audit(
        session,
        user_id,
        "extraction",
        output_payload=metadata_payload,
        execution_time_ms=extraction_ms,
    )

    return UploadResponse(
        document=await _load_document(session, document_id),
        message=None,
        warnings=warnings,
    )


# --------------------------------------------------------------------------
# Phase 3: asynchronous upload (202 Accepted -> Celery document_pipeline)
# --------------------------------------------------------------------------


@router.post("/upload-async", status_code=status.HTTP_202_ACCEPTED)
async def upload_document_async(
    request: Request,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(check_tier_limit),
    session: AsyncSession = Depends(get_tenant_session_with_email),
    _: None = Depends(limit_upload),
) -> dict:
    """Queue one PDF for background ingestion.

    Validates quota + PDF magic synchronously, persists raw bytes to the
    shared volume (/app/uploads/{doc_id}.pdf, mounted into the worker),
    inserts a 'queued' row, and dispatches Celery. Returns HTTP 202 with
    document_id + job_id; progress arrives over Redis Pub/Sub -> SSE.
    The synchronous /upload endpoint above remains as the no-Redis fallback.
    """
    import os

    from ..security.audit import bind_correlation

    correlation_id = bind_correlation(request.headers.get("X-Correlation-ID"))
    filename = _safe_filename(file.filename)
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF files are supported.")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
        )
    if PDF_MAGIC not in data[:1024]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That file is not a valid PDF.")

    document_id, job_id = uuid4(), uuid4()
    await session.execute(
        text(
            """INSERT INTO documents (id, user_id, filename, status, raw_text, metadata)
               VALUES (CAST(CAST(:id AS text) AS uuid), CAST(CAST(:uid AS text) AS uuid),
                       :fn, 'queued', '', CAST(CAST(:md AS text) AS jsonb))"""
        ),
        {"id": str(document_id), "uid": str(user.id), "fn": filename,
         "md": json.dumps({"job_id": str(job_id), "correlation_id": correlation_id})},
    )
    # phase3.sql promotes job_id to a real column; keep a savepoint-guarded
    # backfill so pre-migration databases still accept the row.
    try:
        async with session.begin_nested():
            await session.execute(
                text("UPDATE documents SET job_id = :job WHERE id = CAST(CAST(:did AS text) AS uuid)"),
                {"job": str(job_id), "did": str(document_id)},
            )
    except Exception:  # noqa: BLE001 - column missing pre-migration; metadata carries it
        logger.info("job_id column absent; job tracked in metadata")
    await record_audit(
        session, user.id, "upload_queued",
        output_payload={"document_id": str(document_id), "job_id": str(job_id),
                        "filename": filename, "correlation_id": correlation_id},
    )
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    with open(os.path.join(settings.UPLOAD_DIR, f"{document_id}.pdf"), "wb") as fh:
        fh.write(data)
    # Dispatch inline. The request transaction commits at dependency exit
    # (milliseconds later); the worker treats a not-yet-visible row as
    # transient and retries with backoff (see tasks/ingestion.py Boundary 1).
    from ..tasks.worker import process_document_pipeline

    process_document_pipeline.apply_async(
        args=[str(document_id), str(user.id), user.email, correlation_id],
        queue="document_pipeline",
    )
    return {"document_id": str(document_id), "job_id": str(job_id),
            "status": "queued", "correlation_id": correlation_id}


async def _insert_chunks(
    session: AsyncSession,
    document_id: UUID,
    user_id: UUID,
    filename: str,
    chunks: list[Any],
    vectors: list[list[float]],
) -> None:
    statement = text(
        """
        INSERT INTO document_chunks
            (document_id, user_id, filename, page_number, chunk_index, content, embedding)
        VALUES (
            CAST(CAST(:document_id AS text) AS uuid),
            CAST(CAST(:user_id AS text) AS uuid),
            :filename, :page_number, :chunk_index, :content,
            CAST(CAST(:embedding AS text) AS vector(2048))
        )
        """
    )
    params = [
        {
            "document_id": str(document_id),
            "user_id": str(user_id),
            "filename": filename,
            "page_number": chunk.page_number,
            "chunk_index": chunk.chunk_index,
            "content": chunk.content,
            "embedding": to_vector_literal(vector),
        }
        for chunk, vector in zip(chunks, vectors)
    ]
    # One round trip per batch rather than per chunk.
    for start in range(0, len(params), 50):
        await session.execute(statement, params[start : start + 50])


# --------------------------------------------------------------------------
# Read
# --------------------------------------------------------------------------

_SELECT_DOCUMENTS = """
    SELECT d.id, d.filename, d.category, d.status, d.has_actionable_deadline,
           d.metadata, d.created_at, COUNT(c.id) AS chunk_count
    FROM documents d
    LEFT JOIN document_chunks c
           ON c.document_id = d.id AND c.user_id = d.user_id
    WHERE {where}
    GROUP BY d.id
    ORDER BY d.created_at DESC
"""


async def _load_document(session: AsyncSession, document_id: UUID) -> DocumentOut:
    row = (
        await session.execute(
            text(_SELECT_DOCUMENTS.format(where="d.id = CAST(CAST(:document_id AS text) AS uuid)")),
            {"document_id": str(document_id)},
        )
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    return _document_out(row)


@router.get("", response_model=DocumentListResponse)
async def list_documents(
    category: str | None = Query(None, description="Filter by document category."),
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> DocumentListResponse:
    params: dict[str, Any] = {"user_id": str(user.id), "user_email": user.email.strip().lower()}
    # Owner-OR-shared: RLS already permits shared rows; the explicit predicate
    # must match or recipients see nothing.
    where = (
        "(d.user_id = CAST(CAST(:user_id AS text) AS uuid) OR d.id IN "
        "(SELECT document_id FROM document_shares WHERE shared_with_email = :user_email))"
    )

    if category and category.strip():
        where += " AND d.category = :category"
        params["category"] = category.strip().title()

    rows = (await session.execute(text(_SELECT_DOCUMENTS.format(where=where)), params)).mappings().all()
    return DocumentListResponse(documents=[_document_out(row) for row in rows])


@router.get("/{document_id}", response_model=DocumentOut)
async def get_document(
    document_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> DocumentOut:
    return await _load_document(session, document_id)


@router.get("/{document_id}/file")
async def view_document_file(
    document_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
):
    """Serve the stored PDF inline for the in-app viewer.

    Owner-only via _require_owner (shared recipients get 404, same as a
    missing document). 404 when the binary is gone (deleted uploads dir,
    queued async upload not yet stored).
    """
    return await _serve_document_file(session, document_id, user.id)


@router.get("/{document_id}/file/{filename}")
async def view_document_file_named(
    document_id: UUID,
    filename: str,
    token: str = Query(..., description="JWT in query (iframes send no headers)."),
):
    """Same binary as /file, but the URL ends with the real filename so
    embedded PDF viewers title the tab with the document's name instead of
    a blob hash. The filename segment is cosmetic and unchecked; ownership
    is enforced on document_id exactly like /file."""
    from ..database import AsyncSessionLocal, set_tenant_context

    try:
        payload = decode_access_token(token)
        user_id = UUID(str(payload["sub"]))
        email = str(payload.get("email", ""))
    except Exception as exc:  # noqa: BLE001 - bad token is a clean 401
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token.") from exc
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await set_tenant_context(session, user_id, email)
            return await _serve_document_file(session, document_id, user_id)


async def _serve_document_file(
    session: AsyncSession, document_id: UUID, user_id: UUID,
):
    import os

    await _require_owner(session, document_id, user_id)
    document = await _load_document(session, document_id)
    path = os.path.join(settings.UPLOAD_DIR, f"{document_id}.pdf")
    if not os.path.isfile(path):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="The stored file is no longer available for this upload. Re-upload the PDF to view it.",
        )
    await record_audit(
        session, user_id, "document_view",
        output_payload={"document_id": str(document_id)},
    )
    return FileResponse(
        path, media_type="application/pdf", filename=document.filename,
        content_disposition_type="inline",
    )


@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> Response:
    user_id = user.id
    # Phase 3 soft-cancellation: flag 'deleted' FIRST so any running Celery
    # pipeline aborts at its next stage boundary. Never revoke(terminate=True)
    # mid-transaction — SIGTERM severs connections and orphans chunks.
    await session.execute(
        text("UPDATE documents SET status = 'deleted' WHERE id = CAST(CAST(:did AS text) AS uuid)"),
        {"did": str(document_id)},
    )
    await session.execute(
        text(
            """DELETE FROM document_shares
               WHERE document_id = CAST(CAST(:document_id AS text) AS uuid)
                 AND owner_id = CAST(CAST(:user_id AS text) AS uuid)"""
        ),
        {"document_id": str(document_id), "user_id": str(user_id)},
    )
    result = await session.execute(
        text(
            """DELETE FROM tasks
               WHERE document_id = CAST(CAST(:document_id AS text) AS uuid)
                 AND user_id = CAST(CAST(:user_id AS text) AS uuid)"""
        ),
        {"document_id": str(document_id), "user_id": str(user_id)},
    )
    # Vectors go with the document via ON DELETE CASCADE on document_chunks;
    # delete explicitly for clarity and HNSW index hygiene.
    await session.execute(
        text("DELETE FROM document_chunks WHERE document_id = CAST(CAST(:did AS text) AS uuid)"),
        {"did": str(document_id)},
    )
    await session.execute(
        text("""DELETE FROM pending_actions
                WHERE user_id = CAST(CAST(:uid AS text) AS uuid)
                  AND payload->>'source_document_id' = :did"""),
        {"uid": str(user_id), "did": str(document_id)},
    )
    result = await session.execute(
        text("DELETE FROM documents WHERE id = CAST(CAST(:document_id AS text) AS uuid)"),
        {"document_id": str(document_id)},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    await session.execute(
        text("UPDATE users SET document_count = (SELECT COUNT(*) FROM documents WHERE user_id = CAST(CAST(:uid AS text) AS uuid)) WHERE id = CAST(CAST(:uid AS text) AS uuid)"),
        {"uid": str(user_id)},
    )
    await record_audit(
        session, user_id, "hard_delete",
        output_payload={"document_id": str(document_id)},
    )
    import os

    try:
        os.remove(os.path.join(settings.UPLOAD_DIR, f"{document_id}.pdf"))
    except FileNotFoundError:
        pass
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# Sharing (Pro tier; free-tier owners get 403 before any INSERT)
# --------------------------------------------------------------------------


async def _require_owner(session: AsyncSession, document_id: UUID, user_id: UUID) -> None:
    owns = await session.scalar(
        text("SELECT 1 FROM documents WHERE id = CAST(CAST(:did AS text) AS uuid) AND user_id = CAST(CAST(:uid AS text) AS uuid)"),
        {"did": str(document_id), "uid": str(user_id)},
    )
    if not owns:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")


@router.post("/{document_id}/share", response_model=ShareOut, status_code=status.HTTP_201_CREATED)
async def share_document(
    document_id: UUID,
    payload: ShareCreate,
    user: CurrentUser = Depends(require_pro),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> ShareOut:
    await _require_owner(session, document_id, user.id)
    recipient = payload.shared_with_email.strip().lower()
    if recipient == user.email.strip().lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot share a document with yourself.")
    row = (
        await session.execute(
            text(
                """
                INSERT INTO document_shares (document_id, owner_id, shared_with_email, permission)
                VALUES (
                    CAST(CAST(:did AS text) AS uuid),
                    CAST(CAST(:uid AS text) AS uuid),
                    :email, :perm
                )
                RETURNING id, document_id, owner_id, shared_with_email, permission, created_at
                """
            ),
            {"did": str(document_id), "uid": str(user.id), "email": recipient, "perm": payload.permission},
        )
    ).mappings().one()
    # Notify the recipient if they already have an account.
    recipient_id = await session.scalar(text("SELECT id FROM users WHERE email = :email"), {"email": recipient})
    if recipient_id is not None:
        from uuid import UUID as _UUID

        await create_notification(
            session, _UUID(str(recipient_id)), "Document shared with you",
            f"{user.email} shared a document with you ({payload.permission} access).",
            type="sharing",
        )
    await record_audit(
        session, user.id, "document_share",
        input_payload={"document_id": str(document_id), "shared_with": recipient},
        output_payload={"share_id": str(row["id"])},
    )
    return ShareOut(**dict(row))


@router.get("/{document_id}/shares", response_model=list[ShareOut])
async def list_shares(
    document_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> list[ShareOut]:
    rows = (
        await session.execute(
            text(
                """SELECT id, document_id, owner_id, shared_with_email, permission, created_at
                   FROM document_shares
                   WHERE document_id = CAST(CAST(:did AS text) AS uuid)
                   ORDER BY created_at DESC"""
            ),
            {"did": str(document_id)},
        )
    ).mappings().all()
    if not rows:
        await _require_owner(session, document_id, user.id)
    return [ShareOut(**dict(row)) for row in rows]


@router.delete("/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_share(
    share_id: UUID,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
) -> Response:
    result = await session.execute(
        text("DELETE FROM document_shares WHERE id = CAST(CAST(:sid AS text) AS uuid)"),
        {"sid": str(share_id)},
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
