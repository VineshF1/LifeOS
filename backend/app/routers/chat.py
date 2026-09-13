"""Agentic chat endpoint with programmatic, hallucination-proof citations.

The model never writes source blocks. It emits `[REF: <chunk_uuid>]`, and this
module resolves each tag against the chunks that were actually shown to the
model, then injects the verbatim stored text. A ref to a chunk the model was
never given is deleted rather than rendered.

Phase 2: multi-document synthesis streams via SSE (POST /chat/stream) because
a 4-step scatter-gather at Phase 1's pace (10-15s/turn) lands in the 35-50s
range — past Render's proxy timeout for a silent blocking POST.
"""
from __future__ import annotations

import json
import logging
import re
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from ..agent.loop import run_agent, run_fast_answer, run_fast_answer_stream
from ..database import get_tenant_session_with_email, record_audit
from ..schemas import ChatRequest, ChatResponse, Citation
from ..security import CurrentUser, get_current_user
from ..security.ratelimit import limit_chat
from ..security.sanitization import BUFFER_WINDOW_CHARS, CANARY_PREFIX
from ..services.billing import get_tier

logger = logging.getLogger("lifeos.chat")

router = APIRouter(prefix="/chat", tags=["chat"])

_REF_RE = re.compile(
    # Accept both ASCII [REF: ...] and fullwidth-styled REF tags: models
    # sometimes stylize the brackets, and either form must still resolve.
    r"[【[]REF: *([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}) *[]】]"
)
_EXCERPT_WORDS = 20


def _excerpt(content: str) -> str:
    """First 20 words of the stored chunk, verbatim."""
    words = content.split()
    if len(words) <= _EXCERPT_WORDS:
        return content.strip()
    return " ".join(words[:_EXCERPT_WORDS]) + "..."


def _strip_unresolved_refs(text: str) -> str:
    """Delete any leftover citation-shaped tag the matcher could not resolve
    (wrong brackets, typo'd id, stray spaces) so raw markup never reaches chat.
    Only spans wrapped in [ ] or fullwidth brackets right around REF: qualify;
    ordinary prose is untouched."""
    out: list[str] = []
    i = 0
    while True:
        j = text.find("REF:", i)
        if j == -1:
            out.append(text[i:])
            break
        k = j - 1
        while k >= i and text[k] == " ":
            k -= 1
        if k >= i and text[k] in ("[", "【"):
            m = j + 4
            while m < len(text) and text[m] not in ("]", "】") and (m - j) < 80:
                m += 1
            if m < len(text):
                out.append(text[i:k])
                i = m + 1
                continue
            # Tag runs past the end of the text (model hit max tokens
            # mid-tag): drop the fragment rather than display it.
            out.append(text[i:k])
            break
        out.append(text[i : j + 4])
        i = j + 4
    return "".join(out)


def render_citations(
    answer: str, seen_chunks: dict[str, dict], summary: bool = False
) -> tuple[str, list[Citation]]:
    """Replace every [REF: ...] tag with a resolved, verbatim [Source: ...] tag."""
    answer = _drop_planning_preamble(answer)
    if summary:
        answer = _extract_summary_body(answer)
    ordered: dict[str, Citation] = {}

    def _replace(match: re.Match[str]) -> str:
        chunk_id = match.group(1).lower()
        chunk = seen_chunks.get(chunk_id)
        if chunk is None:
            # Cited a chunk that was never retrieved -- drop the tag rather than
            # display a source that does not exist.
            logger.warning("Dropped citation to unretrieved chunk %s", chunk_id)
            return ""

        excerpt = _excerpt(chunk["content"])
        ordered.setdefault(
            chunk_id,
            Citation(
                chunk_id=UUID(chunk_id),
                filename=chunk["filename"],
                page_number=int(chunk["page_number"]),
                excerpt=excerpt,
            ),
        )
        inline_excerpt = excerpt.replace('"', "'")
        return (
            f'[Source: {chunk["filename"]}, Page: {chunk["page_number"]}, '
            f'Excerpt: "{inline_excerpt}"]'
        )

    rendered = _REF_RE.sub(_replace, answer)
    rendered = _strip_unresolved_refs(rendered)
    for cid in seen_chunks:
        for variant in (cid, cid.lower(), cid.upper()):
            if variant and variant in rendered:
                rendered = rendered.replace(variant, "")
    while "()" in rendered:
        rendered = rendered.replace("()", "")
    rendered = re.sub(r"[ \t]{2,}", " ", rendered)
    return rendered.strip(), list(ordered.values())


# Planning-voice and draft-shorthand markers. A paragraph carrying a real
# citation chip is always kept; anything matching these without a chip is
# model scratchpad, never the answer.
_PLANNING_MARKERS = (
    "we need to",
    "we have ",
    "we'll",
    "let's ",
    "let us ",
    "make sure",
    "provide structured",
    "sentence 1",
    "sentence 2",
    "sentence 3",
    "cite each",
    "attach tags",
    "should have tag",
    "tag if needed",
    "no citation tags",
    "i will ",
    "(same)",
    "(etc",
    "maybe truncated",
    "from chunk",
    "same chunk",
)


def _drop_planning_preamble(text: str) -> str:
    paras: list[list[str]] = [[]]
    for ln in text.splitlines():
        if ln.strip():
            paras[-1].append(ln)
        elif paras[-1]:
            paras.append([])
    paras = [p for p in paras if p]
    kept: list[list[str]] = []
    for p in paras:
        head = " ".join(p).lower()
        if "[source:" in head:
            kept.append(p)
            continue
        if any(m in head for m in _PLANNING_MARKERS):
            continue
        kept.append(p)
    if not kept or len(kept) == len(paras):
        return text
    gap = chr(10) + chr(10)
    return gap.join(chr(10).join(p) for p in kept)


def _extract_summary_body(text: str) -> str:
    """Keep only the templated summary: anything before the first heading is
    draft scratchpad, never the answer. Falls back to the full text when the
    model ignored the template, so a good free-form answer still survives."""
    low = text.lower()
    for anchor in ("**what it is:**", "what it is:"):
        at = low.find(anchor)
        if at != -1:
            return text[at:]
    return text


def _tool_names() -> list[str]:
    from ..agent.tools import TOOL_REGISTRY

    return list(TOOL_REGISTRY)


_SUMMARY_RE = re.compile(
    r"\b(summariz|summarise|explain|tell me about|overview|describe|what is this document|what('s| is) in (this|my|the) document)\b",
    re.IGNORECASE,
)

# Comparison intent keeps the full agent loop (scatter-gather synthesis).
# Everything else on all-docs takes the fast lane.
_COMPARISON_RE = re.compile(
    r"\b(compar|differ|versus|\bvs\b|across|both|all (of )?(my|these|the) documents|"
    r"which (one|document)|best|cheapest|cover(s|age)? (this|that|the))\b",
    re.IGNORECASE,
)


# Action intent keeps the full agent loop — the fast lane can answer but never
# act (no task creation, approvals, calendar, or sharing).
_ACTION_RE = re.compile(
    r"\b(creat|remind|schedule|track|add (a |the )?task|export|share|approve|"
    r"set (a |an )?(reminder|deadline|alert)|notify me|calendar)\b",
    re.IGNORECASE,
)


def _is_action(message: str) -> bool:
    return bool(_ACTION_RE.search(message or ""))


def _is_comparison(message: str) -> bool:
    return bool(_COMPARISON_RE.search(message or ""))


def _is_summary_intent(message: str) -> bool:
    return bool(_SUMMARY_RE.search(message or ""))


async def _sole_document_id(session: AsyncSession) -> UUID | None:
    """The user's document id when they own exactly one live document."""
    rows = (await session.execute(
        text("SELECT id FROM documents WHERE status != 'deleted' LIMIT 2"),
    )).scalars().all()
    if len(rows) == 1:
        raw = rows[0]
        return raw if isinstance(raw, UUID) else UUID(str(raw))
    return None


async def _run_turn(session: AsyncSession, user: CurrentUser, message: str, document_id: UUID | None):
    tier = await get_tier(session, user.id)
    # Summary intent ("explain this document", "tell me about ..."): resolve
    # scope automatically — a single-document user means *that* document —
    # so broad questions also take the fast lane instead of the agent loop.
    if document_id is None and _is_summary_intent(message):
        document_id = await _sole_document_id(session)
    # Fast lane (<10s target): one retrieval + one model call. Only comparisons
    # and actions escalate to the agent loop (synthesis, task creation).
    is_summary = _is_summary_intent(message)
    escalate = _is_comparison(message) or _is_action(message)
    if not escalate:
        result = await run_fast_answer(
            session, user.id, message, document_id, user_email=user.email,
            top_k=8 if is_summary else 5, summary=is_summary,
            max_tokens=1024 if is_summary else 512,
        )
        if is_summary and result.seen_chunks:
            _a, _c = render_citations(result.answer, result.seen_chunks, summary=True)
            if not _c:
                result = await run_fast_answer(
                    session, user.id, message + _RETRY_NUDGE, document_id,
                    user_email=user.email, top_k=8, summary=True, max_tokens=1024,
                )
        return result, tier
    allowed = _tool_names()
    return await run_agent(
        session, user.id, message, document_id,
        user_email=user.email, tier=tier, allowed_tools=allowed,
    ), tier


async def _assert_no_canary(session: AsyncSession, user: CurrentUser, answer: str) -> None:
    """Phase 3 batch-mode canary gate: block before persisting/returning."""
    if CANARY_PREFIX in answer:
        await record_audit(
            session, user.id, "canary_leak_blocked",
            output_payload={"prefix": CANARY_PREFIX},
        )
        logger.error("Canary leak blocked for user %s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Security guardrail tripped: canary leak detected.",
        )


def _buffered_answer_frames(answer: str) -> list[str]:
    """Sliding-window emission: hold back the last BUFFER_WINDOW_CHARS so a
    canary token split across frame boundaries never reaches the socket."""
    frames, buffer = [], ""
    for i in range(0, len(answer), 64):
        buffer += answer[i:i + 64]
        if CANARY_PREFIX in buffer:
            raise _CanaryTrip()
        if len(buffer) > BUFFER_WINDOW_CHARS:
            frames.append(buffer[:-BUFFER_WINDOW_CHARS])
            buffer = buffer[-BUFFER_WINDOW_CHARS:]
    if CANARY_PREFIX in buffer:
        raise _CanaryTrip()
    if buffer:
        frames.append(buffer)
    return frames


class _CanaryTrip(RuntimeError):
    pass


@router.post("", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
    _: None = Depends(limit_chat),
) -> ChatResponse:
    # RLS already scopes this lookup; an unknown id simply returns no row.
    if payload.document_id is not None:
        exists = await session.scalar(
            text(
                """SELECT 1 FROM documents
                   WHERE id = CAST(CAST(:document_id AS text) AS uuid)"""
            ),
            {"document_id": str(payload.document_id)},
        )
        if not exists:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Document not found."
            )

    started = time.perf_counter()
    result, _tier = await _run_turn(session, user, payload.message, payload.document_id)
    answer, citations = render_citations(
        result.answer, result.seen_chunks, summary=_is_summary_intent(payload.message)
    )
    await _assert_no_canary(session, user, answer)
    execution_ms = int((time.perf_counter() - started) * 1000)

    await record_audit(
        session,
        user.id,
        "chat_turn",
        input_payload={
            "message": payload.message,
            "document_id": str(payload.document_id) if payload.document_id else None,
        },
        output_payload={
            "answer": answer,
            "iterations": result.iterations,
            "tools": [trace.model_dump(mode="json") for trace in result.tool_trace],
            "citations": [citation.model_dump(mode="json") for citation in citations],
        },
        execution_time_ms=execution_ms,
    )

    return ChatResponse(
        answer=answer,
        citations=citations,
        tool_trace=result.tool_trace,
        iterations=result.iterations,
    )


# Token holdback: the trailing tail withheld from live `token` events so a
# canary string split across model deltas never reaches the socket. The
# withheld tail is covered by the final rendered `answer` event.
_TOKEN_HOLDBACK_CHARS = len(CANARY_PREFIX) + 8


# Second-attempt nudge when a summary run produces no citable tags.
_RETRY_NUDGE = (
    " Your previous reply attached no citation tags. Reply again in the same"
    " three-part shape, with a [REF: <chunk_id>] tag on each fact."
)


async def _stream_fast_turn(session, user, message, document_id, *, is_summary):
    """Fast-lane turn for the SSE endpoint: retrieval progress, live tokens,
    then the citation-rendered answer. Yields EventSourceResponse dicts."""
    yield {"event": "progress", "data": json.dumps({"stage": "Searching your documents"})}
    raw, sent_len, result = "", 0, None
    async for kind, value in await run_fast_answer_stream(
        session, user.id, message, document_id, user_email=user.email,
        top_k=8 if is_summary else 5,
        max_tokens=1024 if is_summary else 512,
        summary=is_summary,
    ):
        if kind == "token":
            raw += value
            if CANARY_PREFIX in raw:
                await record_audit(
                    session, user.id, "canary_leak_blocked",
                    output_payload={"stream": True, "tokens": True},
                )
                logger.error("Streamed canary leak blocked for user %s", user.id)
                yield {"event": "error", "data": json.dumps(
                    {"message": "Security guardrail tripped: canary leak detected."})}
                return
            emittable = raw[: max(0, len(raw) - _TOKEN_HOLDBACK_CHARS)]
            if len(emittable) > sent_len:
                yield {"event": "token", "data": json.dumps({"content": emittable[sent_len:]})}
                sent_len = len(emittable)
        else:
            result = value
    if result is None:
        raise RuntimeError("Fast turn produced no result.")
    answer, citations = render_citations(raw, result.seen_chunks, summary=is_summary)
    if is_summary and not citations and result.seen_chunks:
        # Scratchpad run: the model answered with no citable tags. One silent
        # second pass with a firmer nudge; the final event carries whichever
        # attempt actually cited its facts.
        raw2, result2, tripped = "", None, False
        async for kind, value in await run_fast_answer_stream(
            session, user.id, message + _RETRY_NUDGE, document_id,
            user_email=user.email, top_k=8, max_tokens=1024, summary=True,
        ):
            if kind == "token":
                raw2 += value
                if CANARY_PREFIX in raw2:
                    tripped = True
                    break
            else:
                result2 = value
        if tripped:
            await record_audit(session, user.id, "canary_leak_blocked",
                               output_payload={"stream": True, "retry": True})
            yield {"event": "error", "data": json.dumps(
                {"message": "Security guardrail tripped: canary leak detected."})}
            return
        if result2 is not None:
            answer2, citations2 = render_citations(raw2, result2.seen_chunks, summary=True)
            if citations2:
                raw, result, answer, citations = raw2, result2, answer2, citations2
    if CANARY_PREFIX in answer:
        await record_audit(session, user.id, "canary_leak_blocked",
                           output_payload={"stream": True})
        yield {"event": "error", "data": json.dumps(
            {"message": "Security guardrail tripped: canary leak detected."})}
        return
    await record_audit(
        session, user.id, "chat_turn",
        input_payload={"message": message, "stream": True,
                       "document_id": str(document_id) if document_id else None},
        output_payload={"answer": answer, "iterations": result.iterations},
    )
    yield {
        "event": "answer",
        "data": json.dumps(
            {
                "answer": answer,
                "citations": [c.model_dump(mode="json") for c in citations],
                "iterations": result.iterations,
            }
        ),
    }


@router.post("/stream")
async def chat_stream(
    payload: ChatRequest,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_session_with_email),
    _: None = Depends(limit_chat),
):
    """SSE stream of one agent turn: progress per tool call, then the answer.

    Keeps the connection transmitting so platform proxies don't 504 a long
    multi-document synthesis. Events: `progress`, `answer`, `error`.
    """
    if payload.document_id is not None:
        exists = await session.scalar(
            text("SELECT 1 FROM documents WHERE id = CAST(CAST(:did AS text) AS uuid)"),
            {"did": str(payload.document_id)},
        )
        if not exists:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")

    async def _gen():
        yield {"event": "progress", "data": json.dumps({"stage": "thinking"})}
        try:
            tier = await get_tier(session, user.id)
            document_id = payload.document_id
            if document_id is None and _is_summary_intent(payload.message):
                document_id = await _sole_document_id(session)
            escalate = _is_comparison(payload.message) or _is_action(payload.message)
            if not escalate:
                # Fast lane with live tokens: words render as generated
                # instead of a silent wait for the whole model call.
                async for event in _stream_fast_turn(
                    session, user, payload.message, document_id,
                    is_summary=_is_summary_intent(payload.message),
                ):
                    yield event
                return
            result, _tier = await _run_turn(session, user, payload.message, payload.document_id)
        except Exception as exc:  # noqa: BLE001 - stream errors as events, not hangs
            logger.exception("Streamed chat turn failed")
            yield {"event": "error", "data": json.dumps({"message": f"AI service unavailable: {exc}"})}
            return
        for trace in result.tool_trace:
            yield {
                "event": "progress",
                "data": json.dumps({"stage": f"Checked {trace.tool_name}", "iteration": trace.iteration}),
            }
        answer, citations = render_citations(result.answer, result.seen_chunks)
        await record_audit(
            session, user.id, "chat_turn",
            input_payload={"message": payload.message, "stream": True},
            output_payload={"answer": answer, "iterations": result.iterations},
        )
        # Token-buffered canary inspection: never emit a tripped answer.
        try:
            frames = _buffered_answer_frames(answer)
        except _CanaryTrip:
            await record_audit(session, user.id, "canary_leak_blocked",
                               output_payload={"stream": True})
            yield {"event": "error", "data": json.dumps(
                {"message": "Security guardrail tripped: canary leak detected."})}
            return
        for frame in frames:
            yield {"event": "answer-chunk", "data": json.dumps({"content": frame})}
        yield {
            "event": "answer",
            "data": json.dumps(
                {
                    "answer": answer,
                    "citations": [c.model_dump(mode="json") for c in citations],
                    "iterations": result.iterations,
                }
            ),
        }

    return EventSourceResponse(_gen())
