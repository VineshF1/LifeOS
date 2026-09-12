"use client";

import { IconRobot, IconSend } from "@tabler/icons-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DocumentOut, ToolTrace } from "@/lib/api";
import { streamChat } from "@/lib/sse";

const SOURCE_TAG = /\[Source:\s*(.*?),\s*Page:\s*(\d+),\s*Excerpt:\s*"([^"]*)"\]/g;

function CitationChip({
  filename,
  page,
  excerpt,
}: {
  filename: string;
  page: string;
  excerpt: string;
}) {
  const short = filename.length > 28 ? `${filename.slice(0, 28)}…` : filename;

  return (
    <details style={{ display: "inline-block", verticalAlign: "middle", margin: "0 4px" }}>
      <summary className="lx-badge lx-badge-blue" style={{ cursor: "pointer" }}>
        {short} · p{page}
      </summary>
      <div className="lx-card citation-pop" style={{ marginTop: 4, padding: "0.5rem 0.65rem" }}>
        <div style={{ fontWeight: 600, fontSize: 12 }}>
          {filename} — page {page}
        </div>
        <div style={{ color: "var(--ink-2)", fontStyle: "italic", fontSize: 12 }}>
          “{excerpt}”
        </div>
      </div>
    </details>
  );
}

function renderWithCitations(text: string) {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(SOURCE_TAG.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(<CitationChip key={`cite-${key++}`} filename={match[1]} page={match[2]} excerpt={match[3]} />);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

/** Custom scope menu: button + origin-aware animated dropdown (no native select). */
function ScopeSelect({
  documents,
  value,
  onPick,
}: {
  documents: DocumentOut[];
  value: string | null;
  onPick: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = documents.find((d) => d.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(id: string | null) {
    onPick(id);
    setOpen(false);
  }

  return (
    <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="chat-scope-label"
        onClick={() => setOpen((v) => !v)}
        className="lx-select"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0.45rem 0.65rem",
          fontSize: "0.82rem",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flex: "none",
            background: current ? "var(--green)" : "var(--accent)",
          }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current ? current.filename : "All documents"}
        </span>
        <motion.span
          aria-hidden
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          style={{ display: "inline-flex", flex: "none", color: "var(--ink-3)" }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </motion.span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.ul
            role="listbox"
            aria-labelledby="chat-scope-label"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              right: 0,
              zIndex: 60,
              margin: 0,
              padding: 4,
              listStyle: "none",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              boxShadow: "var(--shadow-2)",
              maxHeight: 260,
              overflowY: "auto",
              transformOrigin: "top center",
            }}
          >
            <ScopeOption
              active={value === null}
              label="All documents"
              hint={`${documents.length} file${documents.length === 1 ? "" : "s"}`}
              onChoose={() => choose(null)}
            />
            {documents.map((d) => (
              <ScopeOption
                key={d.id}
                active={value === d.id}
                label={d.filename}
                hint={d.category}
                onChoose={() => choose(d.id)}
              />
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ScopeOption({
  active,
  label,
  hint,
  onChoose,
}: {
  active: boolean;
  label: string;
  hint: string;
  onChoose: () => void;
}) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onChoose}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0.5rem 0.6rem",
          border: 0,
          borderRadius: 8,
          background: active ? "var(--accent-soft)" : "transparent",
          color: "inherit",
          font: "inherit",
          fontSize: "0.84rem",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: active ? 650 : 400,
          }}
        >
          {label}
        </span>
        <span className="lx-hint" style={{ flex: "none" }}>{hint}</span>
        {active ? (
          <span aria-hidden style={{ color: "var(--accent)", fontWeight: 700 }}>✓</span>
        ) : null}
      </button>
    </li>
  );
}

type Message =
  | { id: number; role: "user"; content: string }
  | {
      id: number;
      role: "assistant";
      content: string;
      toolTrace: ToolTrace[];
      iterations: number;
    };

interface ChatPaneProps {
  documents: DocumentOut[];
  scopeDocumentId: string | null;
  onScopeChange: (documentId: string | null) => void;
  onSessionExpired: () => void;
  onTasksChanged: () => void;
  /** Phase 3: fired when the chat rate limiter (20/min) trips, for toasts. */
  onRateLimited?: () => void;
}

export function ChatPane({
  documents,
  scopeDocumentId,
  onScopeChange,
  onSessionExpired,
  onTasksChanged,
  onRateLimited,
}: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, stages]);

  // Single-document workspaces: scope to the only document automatically so
  // questions (and summaries) hit the fast lane without manual selection.
  // Otherwise remember the last-used scope in this browser.
  useEffect(() => {
    if (scopeDocumentId === null) {
      if (documents.length === 1) {
        onScopeChange(documents[0].id);
        return;
      }
      try {
        const saved = window.localStorage.getItem("lifeos.chatScope");
        if (saved && documents.some((d) => d.id === saved)) {
          onScopeChange(saved);
        }
      } catch {
        // Private mode — scoping just stays manual.
      }
    }
  }, [scopeDocumentId, documents, onScopeChange]);

  async function send() {
    const question = input.trim();
    if (!question || busy) return;

    setError(null);
    setInput("");
    setStages([]);
    setMessages((previous) => [...previous, { id: nextId.current++, role: "user", content: question }]);
    setBusy(true);

    // Multi-doc synthesis streams progress per tool step so long turns show
    // visible progress instead of a silent wait (proxy-timeout safe).
    await streamChat(question, scopeDocumentId, {
      onProgress: (progress) => {
        setStages((prev) => (prev.includes(progress.stage) ? prev : [...prev, progress.stage]));
      },
      onAnswer: (answer) => {
        setMessages((previous) => [
          ...previous,
          {
            id: nextId.current++,
            role: "assistant",
            content: answer.answer,
            toolTrace: [],
            iterations: answer.iterations ?? 0,
          },
        ]);
        setBusy(false);
        setStages([]);
        onTasksChanged();
      },
      onError: (message) => {
        if (message === "Your session expired. Please sign in again.") {
          onSessionExpired();
          return;
        }
        if (/rate limit|429|slow down|too many requests/i.test(message)) {
          onRateLimited?.();
        }
        setError(message);
        setBusy(false);
        setStages([]);
      },
    });
  }

  function pickScope(next: string | null) {
    try {
      if (next) window.localStorage.setItem("lifeos.chatScope", next);
      else window.localStorage.removeItem("lifeos.chatScope");
    } catch {
      // Private mode — skip persistence.
    }
    onScopeChange(next);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="lx-scopebar">
        <span id="chat-scope-label">Scope</span>
        <ScopeSelect
          documents={documents}
          value={scopeDocumentId}
          onPick={pickScope}
        />
      </div>

      <div ref={scrollRef} className="chat-scroll" style={{ flex: 1, overflowY: "auto", padding: "1rem", minHeight: 320 }}>
        {messages.length === 0 ? (
          <div className="lx-empty">
            <div>
              <span className="lx-avatar soft-blue" style={{ width: 44, height: 44 }}>
                <IconRobot size={22} />
              </span>
            </div>
            <p className="lx-empty-title">Ask about your documents</p>
            <p className="lx-empty-sub">
              Answers arrive with the exact page cited — try one:
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", marginTop: "0.8rem" }}>
              {[
                "When does my car insurance expire?",
                "Which bills are due next month?",
                "Explain this document to me",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="lx-btn lx-btn-secondary lx-btn-sm"
                  style={{ borderRadius: 999 }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="lx-msg" style={{ justifyContent: "flex-end" }}>
                  <div className="lx-bubble user" style={{ maxWidth: "85%" }}>
                    {message.content}
                  </div>
                </div>
              ) : (
                <div key={message.id} className="lx-msg">
                  <div style={{ maxWidth: "94%", minWidth: 0 }}>
                    <div className="lx-bubble ai">
                      <span className="prose-answer">{renderWithCitations(message.content)}</span>
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>
        )}

        {busy ? (
          <div className="lx-bubble ai" style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, color: "var(--ink-2)" }}>
            <span className="skel" style={{ width: 14, height: 14, borderRadius: "50%" }} />
            <span className="stream-caret">
              {stages.length > 0 ? stages[stages.length - 1] : "Reading your documents…"}
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="lx-alert lx-alert-red" role="alert" style={{ margin: "0 1rem 0.5rem" }}>
          {error}
        </div>
      ) : null}

      <div style={{ padding: "0 0.8rem 0.8rem" }}>
        <form
          className="lx-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask a question about your documents…"
            disabled={busy}
            aria-label="Ask a question about your documents"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="lx-send"
            aria-label="Send"
          >
            {busy ? <span className="lx-spinner sm" role="status" /> : <IconSend size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}
