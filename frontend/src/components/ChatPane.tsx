"use client";

import { IconRobot, IconSend, IconUser } from "@tabler/icons-react";
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
    <details className="d-inline-block align-middle mx-1">
      <summary className="badge bg-blue-lt" style={{ cursor: "pointer" }}>
        {short} · p{page}
      </summary>
      <div className="card card-body citation-pop mt-1 p-2">
        <div className="fw-medium" style={{ fontSize: 12 }}>
          {filename} — page {page}
        </div>
        <div className="text-muted fst-italic" style={{ fontSize: 12 }}>
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

  return (
    <div className="d-flex flex-column h-100">
      <div className="d-flex align-items-center gap-2 p-3 border-bottom">
        <label htmlFor="chat-scope" className="form-label mb-0 text-muted">
          Scope
        </label>
        <select
          id="chat-scope"
          value={scopeDocumentId ?? ""}
          onChange={(event) => {
            const next = event.target.value || null;
            try {
              if (next) window.localStorage.setItem("lifeos.chatScope", next);
              else window.localStorage.removeItem("lifeos.chatScope");
            } catch {
              // Private mode — skip persistence.
            }
            onScopeChange(next);
          }}
          className="form-select form-select-sm"
        >
          <option value="">All documents</option>
          {documents.map((document) => (
            <option key={document.id} value={document.id}>
              {document.filename}
            </option>
          ))}
        </select>
      </div>

      <div ref={scrollRef} className="flex-fill p-3 chat-scroll" style={{ overflowY: "auto", minHeight: 320 }}>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">
              <IconRobot size={24} />
            </div>
            <p className="empty-title">Ask about your documents</p>
            <p className="empty-subtitle text-muted">The agent will choose tools and cite sources.</p>
            <div className="empty-action">
              {[
                "When does my car insurance expire?",
                "Which bills are due next month?",
                "What does my rental agreement say about the deposit?",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="btn btn-sm mb-1 me-1"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="d-flex flex-column gap-3">
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="d-flex justify-content-end gap-2">
                  <div className="card card-body p-2 px-3 bg-primary text-white" style={{ maxWidth: "85%" }}>
                    {message.content}
                  </div>
                  <span className="avatar avatar-xs rounded-circle bg-muted-lt">
                    <IconUser size={14} />
                  </span>
                </div>
              ) : (
                <div key={message.id} className="d-flex gap-2">
                  <span className="avatar avatar-xs rounded-circle bg-blue-lt">
                    <IconRobot size={14} />
                  </span>
                  <div style={{ maxWidth: "92%" }} className="min-w-0">
                    <div className="card card-body p-2 px-3">
                      <span className="prose-answer">{renderWithCitations(message.content)}</span>
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>
        )}

        {busy ? (
          <div className="card card-body p-2 px-3 mt-3 text-muted d-flex flex-row align-items-center gap-2">
            <span className="spinner-border spinner-border-sm" role="status" />
            {stages.length > 0 ? stages[stages.length - 1] : "The agent is choosing tools…"}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="alert alert-danger mx-3 mb-2" role="alert">
          {error}
        </div>
      ) : null}

      <div className="p-3 border-top">
        <form
          className="d-flex align-items-center gap-1 ps-1 pe-1 py-1"
          style={{
            border: "1px solid var(--tblr-border-color)",
            borderRadius: 999,
            background: "var(--tblr-bg-surface)",
          }}
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
            className="flex-fill ps-3"
            style={{ border: 0, outline: "none", boxShadow: "none", background: "transparent", minWidth: 0 }}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="btn btn-primary btn-icon rounded-circle flex-shrink-0"
            aria-label="Send"
          >
            {busy ? (
              <span className="spinner-border spinner-border-sm" role="status" />
            ) : (
              <IconSend size={16} />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
