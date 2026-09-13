"""The tool-calling agent loop.

The model -- not this module -- decides which tools to call and in what order.
This file only supplies the state machine, the iteration cap, the wall-clock
budget, and the chunk formatting that makes citations verifiable.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..nim import chat_completion, chat_completion_stream
from ..schemas import ToolTrace
from .tools import TOOL_SCHEMAS, ToolContext, execute_tool

logger = logging.getLogger("lifeos.agent")

SYSTEM_PROMPT = """You are Prova, a privacy-first personal document assistant. \
You answer questions about documents the user has uploaded to their own private workspace.

You decide for yourself which tools to call, how many, and in what order. \
Think about what the question actually needs before acting. You may call several tools in one turn, \
and you may take several turns before answering.

Available tools:
- search_documents: semantic search over the text of the user's documents. Use it when the answer \
depends on what a document actually says (clauses, coverage, terms, exact wording).
- query_structured_data: exact SQL filtering over fields already extracted from the documents \
(category, issuer, action deadline). Use it for filtering and aggregation questions such as \
"which policies expire next month" or "list my utility bills". It is exact and faster than search \
where it applies.
- create_task: create an actionable task for the user.
- synthesize_documents (Pro tier only): scatter-gather comparison across up to 4 documents. Use it \
for comparative questions such as "does my policy cover this invoice". Never call it for free-tier users.
- propose_task_action: draft a write-destructive or external action for HUMAN APPROVAL instead of \
executing it. The user approves in the UI; nothing is committed until they do.
- export_calendar_event: format an existing task as an iCalendar (.ics) event for download.

Hard rules:
1. Cite every factual claim with the exact tag [REF: <chunk_id>], using the CHUNK_ID values shown in \
tool output. Example: "The policy lapses on 12 March 2026 [REF: 4f1c8b2e-...]".
2. Never invent a chunk_id, a filename, or a quotation. If no retrieved chunk supports a claim, \
do not make that claim.
3. Do not write your own "Sources" or "References" section and do not restate filenames or page \
numbers. The application renders full source details from your [REF: ...] tags.
4. If the tools return nothing relevant, say plainly that the documents do not contain the answer. \
Never fall back on general knowledge or outside assumptions about the user.
5. Prefer query_structured_data for questions about categories, issuers or deadlines; prefer \
search_documents for questions about document content.
6. Only call create_task when the user asks you to add, schedule, or track something, or explicitly \
asks for a reminder. Do not create tasks the user did not ask for.
7. Keep the final answer under 5 sentences unless the user explicitly asks for more detail."""

_FORCE_ANSWER_INSTRUCTION = (
    "Answer the user's question now using only the information gathered above. "
    "Do not call any more tools. Attach [REF: <chunk_id>] tags to every factual claim."
)


@dataclass
class AgentResult:
    answer: str
    tool_trace: list[ToolTrace] = field(default_factory=list)
    iterations: int = 0
    # Every chunk actually shown to the model, keyed by chunk_id. The citation
    # renderer accepts refs only from this map, which is what makes a
    # hallucinated citation impossible to display.
    seen_chunks: dict[str, dict[str, Any]] = field(default_factory=dict)


async def run_fast_answer(
    session: AsyncSession,
    user_id: UUID,
    message: str,
    document_id: UUID | None = None,
    *,
    user_email: str | None = None,
    top_k: int = 5,
    summary: bool = False,
    max_tokens: int = 512,
) -> AgentResult:
    """Single-pass RAG turn: one retrieval + one model call, no tool loop.

    Target <10s for document-detail questions (1 embedding + 1 chat call).
    Used for single-document scope and free-tier turns; Pro multi-document
    comparisons keep the full agent loop. Citations stay verifiable: the model
    may only cite chunks recorded in ctx.seen_chunks.
    """
    started = time.perf_counter()
    ctx = ToolContext(session=session, user_id=user_id, document_id=document_id, user_email=user_email)
    result, search_ms = await execute_tool(ctx, "search_documents", {"query": message, "top_k": top_k})
    trace = [ToolTrace(iteration=1, tool_name="search_documents",
                       arguments={"query": message, "top_k": top_k},
                       result_summary=_summarize(result), execution_time_ms=search_ms)]
    chunks = result.get("chunks") or []
    if not chunks:
        return AgentResult(
            answer="Your documents do not contain the answer to that question.",
            tool_trace=trace, iterations=1, seen_chunks=dict(ctx.seen_chunks),
        )
    context = "\n\n".join(
        f"[CHUNK_ID: {c['chunk_id']}] ({c.get('filename', '')}, page {c.get('page_number', '?')}):\n{c['content']}"
        for c in chunks
    )
    scope = _scoped_message(message, document_id)
    system = SUMMARY_SYSTEM_PROMPT if summary else FAST_SYSTEM_PROMPT
    response = await chat_completion(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": f"{scope}\n\nRetrieved context:\n{context}"},
        ],
        temperature=0.2,
        max_tokens=max_tokens,
        timeout=settings.CHAT_TIMEOUT_SECONDS,
        retries=settings.CHAT_TIMEOUT_RETRIES,
    )
    answer = (response.choices[0].message.content or "").strip()
    logger.info("fast_answer chunks=%s %sms", len(chunks), int((time.perf_counter() - started) * 1000))
    return AgentResult(
        answer=answer or "I could not produce an answer for that question.",
        tool_trace=trace, iterations=1, seen_chunks=dict(ctx.seen_chunks),
    )


FAST_SYSTEM_PROMPT = """You answer questions about the user's own uploaded documents using ONLY the retrieved context below. Write directly for the document's owner in plain, simple words, short paragraphs or a few bullets. Begin your reply with the answer itself.

Rules: attach the exact tag [REF: <chunk_id>] from the CHUNK_ID values shown to each factual claim, using plain ASCII square brackets, and say nothing about the tags themselves. If the context lacks the answer, say so plainly. Never write about your own process, plans, or sentences — only the final answer, with no preamble about what you are going to do."""


SUMMARY_SYSTEM_PROMPT = """You answer from ONLY the retrieved context below, writing directly for the document's owner in plain, simple words. Reply with exactly these three parts, in this order, and nothing else — no preamble, no notes about your process, no placeholders like (same) or (etc); write every fact out fully:

**What it is:** one or two sentences saying what the document is.
**Key numbers:** bullets with the important amounts, dates, and names.
**What to do next:** one or two sentences, or Nothing urgent.

Attach the exact tag [REF: <chunk_id>] from the CHUNK_ID values shown to the facts that need one, using plain ASCII square brackets, and say nothing about the tags themselves. If the context lacks the answer, reply with one plain sentence saying so."""


async def run_fast_answer_stream(
    session: AsyncSession,
    user_id: UUID,
    message: str,
    document_id: UUID | None = None,
    *,
    user_email: str | None = None,
    top_k: int = 5,
    max_tokens: int = 512,
    summary: bool = False,
):
    """Streaming twin of run_fast_answer: same retrieval + prompt, but yields
    ("token", delta) events live, then a final ("result", AgentResult).

    Lets the UI render words as the model generates them — first token in
    ~2s — instead of a silent wait for the whole turn.
    """
    from typing import AsyncIterator

    async def _gen() -> AsyncIterator[tuple[str, Any]]:
        ctx = ToolContext(session=session, user_id=user_id, document_id=document_id, user_email=user_email)
        result, search_ms = await execute_tool(ctx, "search_documents", {"query": message, "top_k": top_k})
        trace = [ToolTrace(iteration=1, tool_name="search_documents",
                           arguments={"query": message, "top_k": top_k},
                           result_summary=_summarize(result), execution_time_ms=search_ms)]
        chunks = result.get("chunks") or []
        if not chunks:
            yield ("result", AgentResult(
                answer="Your documents do not contain the answer to that question.",
                tool_trace=trace, iterations=1, seen_chunks=dict(ctx.seen_chunks),
            ))
            return
        context = "\n\n".join(
            f"[CHUNK_ID: {c['chunk_id']}] ({c.get('filename', '')}, page {c.get('page_number', '?')}):\n{c['content']}"
            for c in chunks
        )
        scope = _scoped_message(message, document_id)
        system = SUMMARY_SYSTEM_PROMPT if summary else FAST_SYSTEM_PROMPT
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": f"{scope}\n\nRetrieved context:\n{context}"},
        ]
        answer = ""
        async for delta in chat_completion_stream(
            messages,
            temperature=0.2,
            max_tokens=max_tokens,
            timeout=settings.CHAT_TIMEOUT_SECONDS,
        ):
            answer += delta
            yield ("token", delta)
        yield ("result", AgentResult(
            answer=answer.strip() or "I could not produce an answer for that question.",
            tool_trace=trace, iterations=1, seen_chunks=dict(ctx.seen_chunks),
        ))

    return _gen()


async def run_agent(
    session: AsyncSession,
    user_id: UUID,
    message: str,
    document_id: UUID | None = None,
    *,
    user_email: str | None = None,
    tier: str = "free",
    allowed_tools: list[str] | None = None,
    model: str | None = None,
) -> AgentResult:
    # Escalated (complex) turns default to the 120B model: reliable tool
    # calling matters more than speed once comparisons/actions are involved.
    agent_model = model or settings.LLM_MODEL
    ctx = ToolContext(session=session, user_id=user_id, document_id=document_id, user_email=user_email)
    system = SYSTEM_PROMPT
    if tier != "pro":
        system += "\nNOTE: this user is on the free tier — single-document Q&A only. Never call synthesize_documents."
    tools = TOOL_SCHEMAS
    if allowed_tools is not None:
        wanted = set(allowed_tools)
        tools = [s for s in TOOL_SCHEMAS if s["function"]["name"] in wanted]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": _scoped_message(message, document_id)},
    ]

    trace: list[ToolTrace] = []
    answer = ""
    iterations = 0
    deadline = time.monotonic() + settings.AGENT_TOTAL_BUDGET_SECONDS

    while iterations < settings.AGENT_MAX_ITERATIONS and time.monotonic() < deadline:
        iterations += 1
        response = await chat_completion(
            messages,
            model=agent_model,
            tools=tools,
            timeout=settings.CHAT_TIMEOUT_SECONDS,
            retries=settings.CHAT_TIMEOUT_RETRIES,
        )
        assistant = response.choices[0].message
        tool_calls = list(getattr(assistant, "tool_calls", None) or [])

        if not tool_calls:
            answer = (assistant.content or "").strip()
            break

        messages.append(_assistant_tool_call_message(assistant))
        for call in tool_calls:
            name = call.function.name
            arguments = _parse_arguments(call)
            result, elapsed_ms = await execute_tool(ctx, name, arguments)
            trace.append(
                ToolTrace(
                    iteration=iterations,
                    tool_name=name,
                    arguments=arguments,
                    result_summary=_summarize(result),
                    execution_time_ms=elapsed_ms,
                )
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": _tool_message_content(name, result),
                }
            )
            log = logger.info if "error" not in result else logger.warning
            log("iteration=%s tool=%s %sms", iterations, name, elapsed_ms)

    if not answer:
        # Iteration cap or budget reached with tools still pending: force a
        # grounded answer from the context gathered so far. Timeout/unavailable
        # errors propagate so the router can return a clean 504/502.
        logger.info("Agent stopping after %s iteration(s) without a final answer.", iterations)
        answer = await _force_final_answer(messages, model=agent_model)

    return AgentResult(
        answer=answer or "I could not produce an answer for that question.",
        tool_trace=trace,
        iterations=iterations,
        seen_chunks=ctx.seen_chunks,
    )


async def _force_final_answer(messages: list[dict[str, Any]], model: str | None = None) -> str:
    response = await chat_completion(
        [*messages, {"role": "user", "content": _FORCE_ANSWER_INSTRUCTION}],
        model=model or settings.LLM_MODEL,
        temperature=0.2,
        timeout=settings.CHAT_TIMEOUT_SECONDS,
        retries=settings.CHAT_TIMEOUT_RETRIES,
    )
    return (response.choices[0].message.content or "").strip()


def _scoped_message(message: str, document_id: UUID | None) -> str:
    if document_id:
        return (
            "[SCOPE] The user is asking about a single document. "
            f"document_id = {document_id}. Use this value for source_document_id in create_task.\n\n"
            f"{message}"
        )
    return f"[SCOPE] All of the user's documents.\n\n{message}"


def _assistant_tool_call_message(message: Any) -> dict[str, Any]:
    """Serialise the assistant turn so the API can match tool results to calls."""
    return {
        "role": "assistant",
        "content": message.content or "",
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.function.name,
                    "arguments": call.function.arguments,
                },
            }
            for call in message.tool_calls
        ],
    }


def _parse_arguments(call: Any) -> dict[str, Any]:
    raw = getattr(call.function, "arguments", None) or "{}"
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _tool_message_content(tool_name: str, result: dict[str, Any]) -> str:
    """Format a tool result for the model.

    Search results are rendered as explicit [CHUNK_ID: ...] blocks so the model
    has nothing to guess about when it emits a citation.
    """
    if tool_name == "search_documents":
        if "error" in result:
            return f"Search failed: {result['error']}"
        chunks = result.get("chunks") or []
        if not chunks:
            return "No chunks matched that query. The user's documents may not cover it."

        header = f"{len(chunks)} chunk(s) retrieved by semantic search."
        if result.get("scoped_to_document"):
            header += f" Scoped to document {result['scoped_to_document']}."

        blocks: list[str] = []
        budget = settings.TOOL_RESULT_CHAR_LIMIT
        for chunk in chunks:
            block = (
                f"[CHUNK_ID: {chunk['chunk_id']}] "
                f"(Page {chunk['page_number']}, File: {chunk['filename']})\n"
                f"{chunk['content']}"
            )
            if blocks and len(block) > budget:
                break  # keep whole chunks rather than truncating mid-quote
            blocks.append(block)
            budget -= len(block)
        return header + "\n\n" + "\n\n".join(blocks)

    return json.dumps(result, default=str)[: settings.TOOL_RESULT_CHAR_LIMIT]


def _summarize(result: dict[str, Any]) -> str:
    if "error" in result:
        return f"error: {str(result['error'])[:180]}"
    if "chunks" in result:
        return f"{result.get('result_count', 0)} chunk(s) retrieved"
    if "documents" in result:
        return f"{result.get('result_count', 0)} document(s) matched"
    if result.get("created"):
        return f"task created ({result.get('task_id')})"
    return json.dumps(result, default=str)[:180]
