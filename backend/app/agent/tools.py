"""Registered agent tools.

Each tool runs inside the caller's tenant-scoped transaction, so RLS applies to
every statement even though the tools also carry an explicit `user_id` filter.
Every invocation is written to `audit_logs` with its duration and payload.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import record_audit, to_vector_literal
from ..ingestion import embed_query
from ..schemas import coerce_iso_date

# `:qv` is always bound as text and cast inside SQL, which keeps asyncpg free of
# any pgvector type codec. Embeds are stored as vector(2048) but every ordered
# index/scan goes through halfvec(2048) -- pgvector caps HNSW at 2000 dims for
# the `vector` type, so the expression index in schema.sql is on the halfvec cast.
_QV = "CAST(CAST(:qv AS text) AS halfvec(2048))"
# Must carry the explicit typmod so it matches the expression index in schema.sql.
_EMB = "CAST(embedding AS halfvec(2048))"
_UV = "CAST(CAST(:user_id AS text) AS uuid)"
_DV = "CAST(CAST(:document_id AS text) AS uuid)"

MAX_TOP_K = 12


@dataclass
class ToolContext:
    """Per-turn state shared by every tool call."""

    session: AsyncSession
    user_id: UUID
    document_id: UUID | None = None
    # Recipient email for shared-document access. When set, retrieval spans
    # owned documents plus documents shared with this email (owner-OR-shared).
    user_email: str | None = None
    # chunk_id -> chunk record, for every chunk actually shown to the model.
    # Citation rendering only accepts refs found here.
    seen_chunks: dict[str, dict[str, Any]] = field(default_factory=dict)


def _accessible_doc_filter(ctx: ToolContext, params: dict[str, Any]) -> str:
    """SQL fragment scoping rows to documents the caller may see.

    Owner-OR-shared: owned documents plus documents shared with the caller's
    email. Falls back to owner-only when no email is known (old sessions).
    """
    if ctx.user_email:
        params["user_email"] = ctx.user_email.strip().lower()
        return (
            "document_id IN ("
            "SELECT id FROM documents "
            f"WHERE user_id = {_UV} "
            "UNION "
            "SELECT document_id FROM document_shares "
            "WHERE shared_with_email = :user_email)"
        )
    return f"user_id = {_UV}"


# --------------------------------------------------------------------------
# Tool 1: search_documents
# --------------------------------------------------------------------------


async def search_documents(ctx: ToolContext, query: str, top_k: int = 4) -> dict[str, Any]:
    """Vector similarity retrieval over the authenticated user's chunks."""
    if not isinstance(query, str) or not query.strip():
        return {"error": "`query` must be a non-empty string."}

    try:
        limit = max(1, min(int(top_k), MAX_TOP_K))
    except (TypeError, ValueError):
        limit = 4

    vector = await embed_query(query.strip())
    literal = to_vector_literal(vector)

    params: dict[str, Any] = {"qv": literal, "user_id": str(ctx.user_id), "top_k": limit}
    # Owner-OR-shared scoping (Phase 2): shared chunks carry the owner's
    # user_id, so a plain `user_id = ...` predicate would hide them.
    filters = [_accessible_doc_filter(ctx, params)]
    if ctx.document_id:
        filters.append(f"document_id = {_DV}")
        params["document_id"] = str(ctx.document_id)

    where_clause = " AND ".join(filters)
    rows = (
        await ctx.session.execute(
            text(
                f"""
                SELECT id, document_id, filename, page_number, content,
                       1 - ({_QV} <=> {_EMB}) AS score
                FROM document_chunks
                WHERE {where_clause}
                ORDER BY {_QV} <=> {_EMB}
                LIMIT :top_k
                """
            ),
            params,
        )
    ).mappings().all()

    chunks: list[dict[str, Any]] = []
    for row in rows:
        chunk_id = str(row["id"])
        chunk = {
            "chunk_id": chunk_id,
            "document_id": str(row["document_id"]),
            "filename": row["filename"],
            "page_number": int(row["page_number"] or 1),
            "content": row["content"],
            "score": round(float(row["score"]), 4),
        }
        chunks.append(chunk)
        # Register for citation verification (last write wins is fine; content is identical).
        ctx.seen_chunks[chunk_id] = chunk

    return {
        "query": query,
        "scoped_to_document": str(ctx.document_id) if ctx.document_id else None,
        "result_count": len(chunks),
        "chunks": chunks,
    }


# --------------------------------------------------------------------------
# Tool 2: query_structured_data
# --------------------------------------------------------------------------


async def query_structured_data(
    ctx: ToolContext,
    category: str | None = None,
    expiring_before: str | None = None,
    issuer: str | None = None,
) -> dict[str, Any]:
    """Exact SQL filtering over extracted metadata (no vector search)."""
    params: dict[str, Any] = {"user_id": str(ctx.user_id)}
    if ctx.user_email:
        # Owner-OR-shared: shared rows carry the owner's user_id.
        params["user_email"] = ctx.user_email.strip().lower()
        conditions = [
            "(user_id = "
            f"{_UV} OR id IN (SELECT document_id FROM document_shares "
            "WHERE shared_with_email = :user_email))"
        ]
    else:
        conditions = [f"user_id = {_UV}"]

    if category and str(category).strip():
        conditions.append("category = :category")
        params["category"] = str(category).strip().title()

    if issuer and str(issuer).strip():
        conditions.append("metadata->>'issuer' ILIKE :issuer")
        params["issuer"] = f"%{str(issuer).strip()}%"

    if expiring_before and str(expiring_before).strip():
        deadline = coerce_iso_date(expiring_before)
        if deadline is None:
            return {
                "error": "`expiring_before` must be a date (YYYY-MM-DD).",
                "result_count": 0,
                "documents": [],
            }
        # Stored deadlines are normalised ISO dates, so text comparison is a
        # correct chronological comparison.
        conditions.append("metadata->>'action_deadline' <= :expiring_before")
        conditions.append("metadata->>'action_deadline' IS NOT NULL")
        params["expiring_before"] = deadline

    if ctx.document_id:
        conditions.append(f"id = {_DV}")
        params["document_id"] = str(ctx.document_id)

    rows = (
        await ctx.session.execute(
            text(
                f"""
                SELECT id, filename, category, status, has_actionable_deadline,
                       metadata->>'issuer'             AS issuer,
                       metadata->>'identifier'         AS identifier,
                       metadata->>'action_deadline'    AS action_deadline,
                       metadata->>'action_description' AS action_description,
                       metadata->>'financial_amount'   AS financial_amount,
                       metadata->>'currency'           AS currency
                FROM documents
                WHERE {' AND '.join(conditions)}
                ORDER BY metadata->>'action_deadline' ASC NULLS LAST, created_at DESC
                LIMIT 25
                """
            ),
            params,
        )
    ).mappings().all()

    documents = [dict(row) for row in rows]
    for document in documents:
        document["id"] = str(document["id"])

    return {
        "filters": {
            "category": category,
            "expiring_before": expiring_before,
            "issuer": issuer,
        },
        "result_count": len(documents),
        "documents": documents,
    }


# --------------------------------------------------------------------------
# Tool 3: create_task
# --------------------------------------------------------------------------


async def create_task(
    ctx: ToolContext,
    title: str,
    due_date: str | None = None,
    source_document_id: str | None = None,
) -> dict[str, Any]:
    """Insert a pending task owned by the authenticated tenant."""
    if not isinstance(title, str) or not title.strip():
        return {"error": "`title` must be a non-empty string."}

    resolved_document_id = source_document_id or ctx.document_id
    document_id: str | None = None

    if resolved_document_id:
        try:
            candidate = UUID(str(resolved_document_id))
        except (ValueError, AttributeError, TypeError):
            return {"error": f"`source_document_id` is not a valid UUID: {resolved_document_id!r}"}

        # RLS restricts this lookup; shared documents resolve too when the
        # caller is the recipient (owner-OR-shared).
        lookup_params: dict[str, Any] = {"doc_id": str(candidate), "user_id": str(ctx.user_id)}
        ownership_clause = f"user_id = {_UV}"
        if ctx.user_email:
            lookup_params["user_email"] = ctx.user_email.strip().lower()
            ownership_clause = (
                f"(user_id = {_UV} OR id IN (SELECT document_id FROM document_shares "
                "WHERE shared_with_email = :user_email))"
            )
        exists = await ctx.session.scalar(
            text(
                f"""SELECT 1 FROM documents
                    WHERE id = CAST(CAST(:doc_id AS text) AS uuid) AND {ownership_clause}"""
            ),
            lookup_params,
        )
        if exists:
            document_id = str(candidate)
        else:
            # Never create a task with silently-dropped provenance: an id that
            # does not resolve to one of the caller's documents is a
            # hallucination, and the model should know that.
            return {"error": "`source_document_id` does not belong to any of your documents."}

    normalized_due = coerce_iso_date(due_date)
    if due_date and normalized_due is None:
        return {"error": f"`due_date` must be a date (YYYY-MM-DD), received {due_date!r}."}

    row = (
        await ctx.session.execute(
            text(
                """
                INSERT INTO tasks (user_id, document_id, title, due_date, status)
                VALUES (
                    CAST(CAST(:user_id AS text) AS uuid),
                    CAST(CAST(:document_id AS text) AS uuid),
                    :title,
                    CAST(CAST(:due_date AS text) AS date),
                    'pending'
                )
                RETURNING id, title, due_date, status, document_id
                """
            ),
            {
                "user_id": str(ctx.user_id),
                "document_id": document_id,
                "title": title.strip()[:255],
                "due_date": normalized_due,
            },
        )
    ).mappings().one()

    return {
        "created": True,
        "task_id": str(row["id"]),
        "title": row["title"],
        "due_date": row["due_date"].isoformat() if row["due_date"] else None,
        "status": row["status"],
        "source_document_id": str(row["document_id"]) if row["document_id"] else None,
    }


# --------------------------------------------------------------------------
# Phase 2 Tool 4: synthesize_documents (Pro-gated scatter-gather)
# --------------------------------------------------------------------------


async def synthesize_documents(
    ctx: ToolContext,
    doc_ids: list[str] | None = None,
    prompt: str = "",
    per_doc_top_k: int | None = None,
) -> dict[str, Any]:
    """Cross-reference up to SYNTHESIZE_MAX_DOCS documents on one question.

    Scatter: one scoped vector search per document. Gather: a comparison
    matrix of per-document findings with chunk_ids the renderer can cite.
    Fan-out is capped so the SSE stream stays inside the proxy timeout.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        return {"error": "`prompt` must be a non-empty string."}
    ids = [str(d) for d in (doc_ids or []) if str(d).strip()]
    if not ids:
        return {"error": "`doc_ids` must list at least one document UUID."}
    try:
        from ..config import settings as _settings

        max_docs = int(_settings.SYNTHESIZE_MAX_DOCS)
        default_k = int(_settings.SYNTHESIZE_TOP_K_PER_DOC)
    except (ImportError, AttributeError, TypeError, ValueError):
        max_docs, default_k = 4, 3
    ids = ids[:max(1, max_docs)]
    try:
        k = max(1, min(int(per_doc_top_k) if per_doc_top_k else default_k, 6))
    except (TypeError, ValueError):
        k = default_k

    per_doc: list[dict[str, Any]] = []
    for doc_id in ids:
        try:
            candidate = str(UUID(str(doc_id)))
        except (ValueError, AttributeError, TypeError):
            per_doc.append({"document_id": doc_id, "error": "Not a valid UUID."})
            continue
        saved_scope = ctx.document_id
        ctx.document_id = UUID(candidate)
        try:
            result = await search_documents(ctx, prompt.strip(), top_k=k)
        finally:
            ctx.document_id = saved_scope
        if "error" in result:
            per_doc.append({"document_id": candidate, **result})
            continue
        findings = [
            {
                "chunk_id": c["chunk_id"],
                "filename": c["filename"],
                "page_number": c["page_number"],
                "content": c["content"][:1500],
                "score": c["score"],
            }
            for c in result.get("chunks", [])
        ]
        per_doc.append(
            {
                "document_id": candidate,
                "filename": findings[0]["filename"] if findings else None,
                "result_count": len(findings),
                "findings": findings,
            }
        )
    return {"prompt": prompt.strip(), "documents": per_doc}


# --------------------------------------------------------------------------
# Phase 2 Tool 5: propose_task_action (human-in-the-loop draft)
# --------------------------------------------------------------------------


async def propose_task_action(
    ctx: ToolContext,
    title: str,
    due_date: str | None = None,
    doc_id: str | None = None,
) -> dict[str, Any]:
    """Draft an external action into `pending_actions` (status pending).

    Nothing is committed: the frontend surfaces an approval modal, and the
    action executes only after POST /pending-actions/{id}/approve.
    Rows auto-expire after 24h (see expires_at default).
    """
    if not isinstance(title, str) or not title.strip():
        return {"error": "`title` must be a non-empty string."}
    normalized_due = coerce_iso_date(due_date)
    if due_date and normalized_due is None:
        return {"error": f"`due_date` must be a date (YYYY-MM-DD), received {due_date!r}."}
    resolved_doc: str | None = None
    if doc_id or ctx.document_id:
        candidate_raw = doc_id or str(ctx.document_id)
        try:
            resolved_doc = str(UUID(str(candidate_raw)))
        except (ValueError, AttributeError, TypeError):
            return {"error": f"`doc_id` is not a valid UUID: {candidate_raw!r}"}
    row = (
        await ctx.session.execute(
            text(
                """
                INSERT INTO pending_actions (user_id, action_type, payload, status)
                VALUES (
                    CAST(CAST(:user_id AS text) AS uuid),
                    'create_task',
                    CAST(CAST(:payload AS text) AS jsonb),
                    'pending'
                )
                RETURNING id, action_type, payload, status, created_at, expires_at
                """
            ),
            {
                "user_id": str(ctx.user_id),
                "payload": json.dumps(
                    {
                        "title": title.strip()[:255],
                        "due_date": normalized_due,
                        "source_document_id": resolved_doc,
                    }
                ),
            },
        )
    ).mappings().one()
    payload = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"])
    return {
        "proposed": True,
        "pending_action_id": str(row["id"]),
        "action_type": row["action_type"],
        "payload": payload,
        "status": row["status"],
        "expires_at": row["expires_at"].isoformat() if row["expires_at"] else None,
        "message": "Action drafted and awaiting user approval.",
    }


# --------------------------------------------------------------------------
# Phase 2 Tool 6: export_calendar_event (.ics for a confirmed task)
# --------------------------------------------------------------------------


async def export_calendar_event(ctx: ToolContext, task_id: str) -> dict[str, Any]:
    """Format a task as a downloadable iCalendar (.ics) event."""
    try:
        candidate = str(UUID(str(task_id)))
    except (ValueError, AttributeError, TypeError):
        return {"error": f"`task_id` is not a valid UUID: {task_id!r}"}
    row = (
        await ctx.session.execute(
            text(
                f"""SELECT t.id, t.title, t.due_date, t.status
                    FROM tasks t
                    WHERE t.id = CAST(CAST(:task_id AS text) AS uuid)
                      AND t.user_id = {_UV}"""
            ),
            {"task_id": candidate, "user_id": str(ctx.user_id)},
        )
    ).mappings().first()
    if row is None:
        return {"error": "Task not found."}
    due = row["due_date"].isoformat() if row["due_date"] else None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    uid = f"{candidate}@lifeos.agent"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Prova//Tasks//EN",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{stamp}",
        f"SUMMARY:{str(row['title']).replace(chr(10), ' ')}",
    ]
    if due:
        lines.append(f"DTSTART;VALUE=DATE:{due.replace('-', '')}")
    lines += ["STATUS:CONFIRMED" if row["status"] == "completed" else "STATUS:NEEDS-ACTION", "END:VEVENT", "END:VCALENDAR"]
    return {
        "task_id": candidate,
        "title": row["title"],
        "due_date": due,
        "ics": "\r\n".join(lines) + "\r\n",
    }


# --------------------------------------------------------------------------
# Registry
# --------------------------------------------------------------------------

ToolHandler = Callable[..., Coroutine[Any, Any, dict[str, Any]]]

TOOL_REGISTRY: dict[str, ToolHandler] = {
    "search_documents": search_documents,
    "query_structured_data": query_structured_data,
    "create_task": create_task,
    "synthesize_documents": synthesize_documents,
    "propose_task_action": propose_task_action,
    "export_calendar_event": export_calendar_event,
}

CATEGORIES = ["Insurance", "Tax", "Vehicle", "Utility", "Warranty", "Rental", "General"]

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": (
                "Semantic search over the text of the user's stored documents. "
                "Returns the most relevant chunks with their chunk_id, filename, page "
                "number and content. Use this when the answer depends on what a "
                "document actually says (clauses, coverage, terms, wording)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural-language search query.",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Number of chunks to return. Default 4.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_structured_data",
            "description": (
                "Exact SQL filtering over the structured fields already extracted from "
                "the user's documents: category, issuer, and action deadline. Use this "
                "for filtering or aggregation questions such as 'which policies expire "
                "next month' or 'list my utility bills'. It does not read document text, "
                "so it is faster and exact where it applies."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": CATEGORIES,
                        "description": "Filter by document category. Omit for all categories.",
                    },
                    "expiring_before": {
                        "type": "string",
                        "description": (
                            "ISO date YYYY-MM-DD. Returns only documents whose action "
                            "deadline falls on or before this date. Omit to ignore deadlines."
                        ),
                    },
                    "issuer": {
                        "type": "string",
                        "description": (
                            "Case-insensitive partial match on the issuer/provider name. "
                            "Omit to ignore the issuer."
                        ),
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_task",
            "description": (
                "Create an actionable task for the user. Call this only when the user "
                "asks you to add, schedule, or track something, or explicitly asks for a "
                "reminder."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short imperative task title, e.g. 'Pay electricity bill'.",
                    },
                    "due_date": {
                        "type": "string",
                        "description": "ISO date YYYY-MM-DD the task is due.",
                    },
                    "source_document_id": {
                        "type": "string",
                        "description": (
                            "UUID of the document this task came from. Use the document_id "
                            "given in the conversation scope."
                        ),
                    },
                },
                "required": ["title", "due_date", "source_document_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "synthesize_documents",
            "description": (
                "Cross-document synthesis (Pro tier). Compares up to 4 documents on "
                "one question and returns per-document findings with citable chunk_ids. "
                "Use for comparative questions such as 'does my policy cover this invoice'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "UUIDs of the documents to compare (max 4).",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The comparison question, e.g. 'water damage coverage vs repair cost'.",
                    },
                    "per_doc_top_k": {
                        "type": "integer",
                        "description": "Chunks per document. Default 3.",
                    },
                },
                "required": ["doc_ids", "prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "propose_task_action",
            "description": (
                "Draft an external action for HUMAN APPROVAL instead of executing it. "
                "Writes a pending row and pauses; the user approves in the UI. Use for "
                "write-destructive or external actions (schedule, mark paid, share)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short imperative action title.",
                    },
                    "due_date": {
                        "type": "string",
                        "description": "ISO date YYYY-MM-DD.",
                    },
                    "doc_id": {
                        "type": "string",
                        "description": "UUID of the related document, if any.",
                    },
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "export_calendar_event",
            "description": (
                "Format an existing task as an iCalendar (.ics) event for download. "
                "Call with the task_id of a confirmed task."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {
                        "type": "string",
                        "description": "UUID of the task to export.",
                    },
                },
                "required": ["task_id"],
            },
        },
    },
]


async def execute_tool(
    ctx: ToolContext, name: str, arguments: dict[str, Any]
) -> tuple[dict[str, Any], int]:
    """Dispatch one tool call, audit it, and return (result, duration_ms).

    Tool failures are returned to the model as data rather than raised, so the
    agent loop can adapt instead of collapsing the turn.
    """
    handler = TOOL_REGISTRY.get(name)
    started = time.perf_counter()

    if handler is None:
        result: dict[str, Any] = {"error": f"Unknown tool '{name}'."}
    else:
        try:
            # SAVEPOINT: a handler that fails mid-statement would otherwise abort
            # the request transaction and break every later query.
            async with ctx.session.begin_nested():
                result = await handler(ctx, **arguments)
        except TypeError as exc:
            result = {"error": f"Invalid arguments for '{name}': {exc}"}
        except Exception as exc:  # noqa: BLE001 - surfaced to the model as data
            result = {"error": f"'{name}' failed: {exc}"}

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    await record_audit(
        ctx.session,
        ctx.user_id,
        "tool_call",
        tool_name=name,
        input_payload=arguments,
        output_payload=_audit_payload(result),
        execution_time_ms=elapsed_ms,
    )
    return result, elapsed_ms


def _audit_payload(result: dict[str, Any]) -> dict[str, Any]:
    """Keep audit rows small: full chunk text is already in document_chunks."""
    if "chunks" in result:
        trimmed = {k: v for k, v in result.items() if k != "chunks"}
        trimmed["chunks"] = [
            {
                "chunk_id": chunk["chunk_id"],
                "filename": chunk["filename"],
                "page_number": chunk["page_number"],
                "score": chunk["score"],
            }
            for chunk in result["chunks"]
        ]
        return trimmed
    return result
