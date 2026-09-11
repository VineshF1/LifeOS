"""Stateful Phase 2 agent graph (LangGraph) wrapping the Phase 1 tools.

Phase 1's `loop.py` is stateless: it cannot pause mid-turn, wait for a human,
and resume later on another worker. This graph replaces it for approval-gated
turns while REUSING the same tool implementations from `tools.py` — they are
wrapped in LangGraph's tool format, not rewritten.

Persistence: `AsyncPostgresSaver` on the same Neon database (NOT in-memory),
so an interrupted approval survives restarts and load-balanced workers.
The `pending_actions` table remains the source of truth the UI reads; the
LangGraph interrupt only pauses execution, it is not the storage.

If LangGraph is not installed, `HAS_LANGGRAPH` is False and callers fall back
to `loop.run_agent` — the API never 500s on an optional dependency.
"""
from __future__ import annotations

import contextvars
import logging
from typing import Any, Literal
from uuid import UUID

logger = logging.getLogger("lifeos.graph")

try:
    from langchain_core.messages import BaseMessage
    from langchain_core.tools import tool as langchain_tool
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from langgraph.graph import END, StateGraph
    from langgraph.prebuilt import ToolNode
    from langgraph.types import Command, interrupt
    from typing_extensions import TypedDict

    HAS_LANGGRAPH = True
except ImportError:  # pragma: no cover - optional dependency
    HAS_LANGGRAPH = False

from ..config import settings

if HAS_LANGGRAPH:
    from . import tools as _tools

    _CTX: contextvars.ContextVar = contextvars.ContextVar("lifeos_tool_ctx")

    def _ctx() -> _tools.ToolContext:
        return _CTX.get()

    @langchain_tool
    async def search_documents(query: str, top_k: int = 4) -> dict[str, Any]:
        """Semantic search over the user's stored documents."""
        result, _ = await _tools.execute_tool(_ctx(), "search_documents", {"query": query, "top_k": top_k})
        return result

    @langchain_tool
    async def query_structured_data(
        category: str | None = None, expiring_before: str | None = None, issuer: str | None = None
    ) -> dict[str, Any]:
        """Exact SQL filtering over extracted document metadata."""
        result, _ = await _tools.execute_tool(
            _ctx(),
            "query_structured_data",
            {"category": category, "expiring_before": expiring_before, "issuer": issuer},
        )
        return result

    @langchain_tool
    async def create_task(title: str, due_date: str | None = None, source_document_id: str | None = None) -> dict[str, Any]:
        """Create a task immediately (read-write but non-external)."""
        result, _ = await _tools.execute_tool(
            _ctx(), "create_task", {"title": title, "due_date": due_date, "source_document_id": source_document_id}
        )
        return result

    @langchain_tool
    async def synthesize_documents(doc_ids: list[str], prompt: str, per_doc_top_k: int | None = None) -> dict[str, Any]:
        """Cross-document synthesis (Pro tier). Compares up to 4 documents."""
        result, _ = await _tools.execute_tool(
            _ctx(), "synthesize_documents", {"doc_ids": doc_ids, "prompt": prompt, "per_doc_top_k": per_doc_top_k}
        )
        return result

    @langchain_tool
    async def propose_task_action(title: str, due_date: str | None = None, doc_id: str | None = None) -> dict[str, Any]:
        """Draft an external action into pending_actions for human approval."""
        result, _ = await _tools.execute_tool(
            _ctx(), "propose_task_action", {"title": title, "due_date": due_date, "doc_id": doc_id}
        )
        return result

    @langchain_tool
    async def export_calendar_event(task_id: str) -> dict[str, Any]:
        """Format a task as an iCalendar (.ics) event."""
        result, _ = await _tools.execute_tool(_ctx(), "export_calendar_event", {"task_id": task_id})
        return result

    _ALL_WRAPPED = [search_documents, query_structured_data, create_task, synthesize_documents, propose_task_action, export_calendar_event]
    _FREE_WRAPPED = [search_documents, query_structured_data, create_task, export_calendar_event]

    class GraphState(TypedDict, total=False):
        messages: list[BaseMessage]
        tier: str
        pending_action_id: str | None
        approval_status: Literal["pending", "approved", "rejected"] | None

    _CHECKPOINTER: Any | None = None
    _CHECKPOINTER_CM: Any | None = None

    def _psycopg_dsn() -> str:
        raw = (settings.DATABASE_URL or "").strip()
        for prefix in ("postgresql+asyncpg://", "postgres://"):
            if raw.startswith(prefix):
                raw = "postgresql://" + raw[len(prefix):]
                break
        return raw

    async def ensure_checkpointer() -> Any:
        """Return a set-up AsyncPostgresSaver (creates checkpoint tables once).

        In langgraph-checkpoint-postgres 2.x `from_conn_string` returns an
        async context manager, not a saver — it must be entered before
        `.setup()` exists. The CM is cached module-wide and exited via
        `aclose_checkpointer()` on app shutdown.
        """
        global _CHECKPOINTER, _CHECKPOINTER_CM
        if _CHECKPOINTER is None:
            _CHECKPOINTER_CM = AsyncPostgresSaver.from_conn_string(_psycopg_dsn())
            saver = await _CHECKPOINTER_CM.__aenter__()
            await saver.setup()
            _CHECKPOINTER = saver
        return _CHECKPOINTER

    async def aclose_checkpointer() -> None:
        """Exit the cached checkpointer CM (app shutdown; never raises)."""
        global _CHECKPOINTER, _CHECKPOINTER_CM
        if _CHECKPOINTER_CM is not None:
            try:
                await _CHECKPOINTER_CM.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001 - shutdown must not fail
                logger.exception("Error closing LangGraph checkpointer")
            finally:
                _CHECKPOINTER = None
                _CHECKPOINTER_CM = None

    def _llm(*, tools: list, model: str | None = None):
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=model or settings.LLM_MODEL,
            openai_api_key=settings.NVIDIA_API_KEY,
            openai_api_base=settings.NVIDIA_BASE_URL.rstrip("/"),
            temperature=0.2,
            max_tokens=settings.AGENT_MAX_TOKENS,
            timeout=settings.CHAT_TIMEOUT_SECONDS,
            max_retries=settings.CHAT_TIMEOUT_RETRIES,
        ).bind_tools(tools)

    def build_graph():
        """Intent router → tools → (propose gate with interrupt) → answer."""
        free_llm = _llm(tools=_FREE_WRAPPED)
        pro_llm = _llm(tools=_ALL_WRAPPED)
        free_tools = ToolNode(_FREE_WRAPPED)
        pro_tools = ToolNode(_ALL_WRAPPED)

        def _pick(state: GraphState):
            tier = state.get("tier", "free")
            return (pro_llm if tier == "pro" else free_llm), (pro_tools if tier == "pro" else free_tools)

        async def agent(state: GraphState) -> dict:
            llm, _ = _pick(state)
            response = await llm.ainvoke(state["messages"])
            return {"messages": [response]}

        async def gateway(state: GraphState):
            last = state["messages"][-1]
            calls = list(getattr(last, "tool_calls", None) or [])
            if not calls:
                return END
            if any(c.get("name") == "propose_task_action" for c in calls):
                return "propose_gate"
            return "tools"

        async def propose_gate(state: GraphState) -> dict:
            """Pause AFTER the draft row exists; resume only on user decision."""
            last = state["messages"][-1]
            proposal = ""
            for call in getattr(last, "tool_calls", None) or []:
                if call.get("name") == "propose_task_action":
                    proposal = str((call.get("args", {}) or {}).get("title", ""))
            decision = interrupt({"question": "approve_action", "proposal": proposal})
            # Resumed via Command(resume="approve"|"reject") from the approval API.
            return {"approval_status": "approved" if str(decision).lower() == "approve" else "rejected"}

        builder = StateGraph(GraphState)
        builder.add_node("agent", agent)
        builder.add_node("tools", lambda state: _pick(state)[1].ainvoke(state))
        builder.add_node("propose_gate", propose_gate)
        builder.set_entry_point("agent")
        builder.add_conditional_edges("agent", gateway, {"tools": "tools", "propose_gate": "propose_gate", END: END})
        builder.add_edge("tools", "agent")
        builder.add_edge("propose_gate", "agent")
        return builder

    _GRAPH: Any | None = None

    def thread_id_for(user_id: str, session_id: str) -> str:
        """Phase 3 canonical checkpoint namespace: f"{user_id}:{session_id}".

        Purge routines must match BOTH this and the raw str(user_id) form
        (see routers/privacy.py): the stateless loop.py path never namespaced.
        """
        return f"{user_id}:{session_id}"

    async def run_graph_turn(
        *,
        ctx: _tools.ToolContext,
        message: str,
        tier: str = "free",
        thread_id: str,
        resume: str | None = None,
    ) -> dict[str, Any]:
        """Run one graph turn; returns answer/trace/seen/pending info."""
        from langchain_core.messages import HumanMessage

        global _GRAPH
        checkpointer = await ensure_checkpointer()
        if _GRAPH is None:
            _GRAPH = build_graph().compile(checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}}
        token = _CTX.set(ctx)
        try:
            if resume is not None:
                result = await _GRAPH.ainvoke(Command(resume=resume), config=config)
            else:
                scope = (
                    f"[SCOPE] The user is asking about a single document. document_id = {ctx.document_id}."
                    if ctx.document_id
                    else "[SCOPE] All of the user's documents."
                )
                if tier != "pro":
                    scope += " NOTE: free tier — single-document Q&A only; do not call synthesize_documents."
                result = await _GRAPH.ainvoke(
                    {"messages": [HumanMessage(content=f"{scope}\n\n{message}")], "tier": tier},
                    config=config,
                )
        finally:
            _CTX.reset(token)
        messages = result.get("messages", [])
        answer = ""
        for msg in reversed(messages):
            if getattr(msg, "type", "") == "ai" and not getattr(msg, "tool_calls", None) and (msg.content or "").strip():
                answer = str(msg.content).strip()
                break
        return {
            "answer": answer or "I could not produce an answer for that question.",
            "iterations": len([m for m in messages if getattr(m, "type", "") == "ai"]),
            "approval_status": result.get("approval_status"),
            "pending_action_id": result.get("pending_action_id"),
            "seen_chunks": dict(ctx.seen_chunks),
        }

else:  # pragma: no cover - import-time fallback

    def thread_id_for(user_id: str, session_id: str) -> str:  # type: ignore[no-redef]
        return f"{user_id}:{session_id}"

    async def run_graph_turn(**kwargs):  # type: ignore[no-redef]
        raise RuntimeError("LangGraph is not installed.")

    async def aclose_checkpointer() -> None:  # type: ignore[no-redef]
        """No-op when LangGraph is not installed."""
        return None
