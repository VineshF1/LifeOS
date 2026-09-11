/**
 * Phase 2 real-time clients.
 *
 * - `streamChat`: POST /chat/stream via fetch + incremental SSE parsing.
 *   EventSource can't POST, so multi-doc synthesis streams over fetch with
 *   progress callbacks per tool step, then the final cited answer.
 * - `openNotificationStream`: GET /notifications/stream via EventSource
 *   (token travels in the query string because EventSource sets no headers).
 */
import { ApiError, getToken } from "./api";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:8000";

const CHAT_TIMEOUT_MS = 180_000;

export interface StreamProgress {
  stage: string;
  iteration?: number;
}

export interface StreamAnswer {
  answer: string;
  citations: Array<{ chunk_id: string; filename: string; page_number: number; excerpt: string }>;
  iterations: number;
}

function apiBase(): string {
  return API_BASE;
}

export async function streamChat(
  message: string,
  documentId: string | null,
  handlers: {
    onProgress: (progress: StreamProgress) => void;
    onAnswer: (answer: StreamAnswer) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${apiBase()}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, document_id: documentId }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    handlers.onError(
      error instanceof DOMException && error.name === "AbortError"
        ? "That took too long. Please retry in a moment."
        : `Cannot reach the API at ${apiBase()}. Is the backend running?`,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || !response.body) {
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.message === "string") detail = body.message;
      else if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // Non-JSON error page.
    }
    if (response.status === 401) handlers.onError("Your session expired. Please sign in again.");
    else if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      handlers.onError(
        `Rate limit hit (20 chats/min)${retryAfter ? ` — retry in ${retryAfter}s` : ""}. Slow down and retry.`,
      );
    } else handlers.onError(detail);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";

  function dispatch(data: string) {
    try {
      const payload = JSON.parse(data);
      if (event === "progress") handlers.onProgress(payload as StreamProgress);
      else if (event === "answer") handlers.onAnswer(payload as StreamAnswer);
      else if (event === "error") handlers.onError(String(payload?.message ?? "Chat failed."));
    } catch {
      // Partial frame — wait for more bytes.
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dispatch(line.slice(5).trim());
      }
    }
  }
}

export function openWorkerLiveStream(handlers: {
  onStatus: (payload: { document_id: string; status: string; correlation_id?: string }) => void;
  onFailed: (payload: { document_id: string; error: string }) => void;
  onError: () => void;
}): EventSource | null {
  const token = getToken();
  if (!token) return null;
  const source = new EventSource(
    `${apiBase()}/notifications/live?token=${encodeURIComponent(token)}`,
  );
  source.addEventListener("document_status", (e) => {
    try {
      handlers.onStatus(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  source.addEventListener("document_failed", (e) => {
    try {
      handlers.onFailed(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  source.onerror = () => handlers.onError();
  return source;
}

export function openNotificationStream(handlers: {
  onReady: (payload: { unread: number; new_deadlines: number }) => void;
  onHeartbeat: (payload: { unread: number; today: string }) => void;
  onError: () => void;
}): EventSource | null {
  const token = getToken();
  if (!token) return null;
  const source = new EventSource(
    `${apiBase()}/notifications/stream?token=${encodeURIComponent(token)}`,
  );
  source.addEventListener("ready", (e) => {
    try {
      handlers.onReady(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  source.addEventListener("heartbeat", (e) => {
    try {
      handlers.onHeartbeat(JSON.parse((e as MessageEvent).data));
    } catch {
      // Ignore malformed frames.
    }
  });
  source.onerror = () => handlers.onError();
  return source;
}

export { ApiError };
