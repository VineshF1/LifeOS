/**
 * Typed API client. Attaches the JWT Bearer token and normalises every error
 * into an ApiError carrying the backend's own message.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "http://localhost:8000";

const TOKEN_KEY = "prova.token";
const TOKEN_COOKIE = "prova.token";
const LEGACY_KEY = "lifeos.token";

// Upload runs chunking, embedding and extraction; chat runs up to 4 agent turns.
const UPLOAD_TIMEOUT_MS = 180_000;
const CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  const local = window.localStorage.getItem(TOKEN_KEY) || window.localStorage.getItem(LEGACY_KEY);
  if (local) return local;
  const match = document.cookie.match(/(?:^|; )prova\.token=([^;]*)/) || document.cookie.match(/(?:^|; )lifeos\.token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.removeItem(LEGACY_KEY);
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=604800; SameSite=Lax`;
  document.cookie = `${LEGACY_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(LEGACY_KEY);
  document.cookie = `${TOKEN_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  document.cookie = `${LEGACY_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface UserOut {
  id: string;
  email: string;
  created_at: string;
  subscription_tier: string;
  document_count: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user: UserOut;
}

export interface DocumentMetadata {
  category?: string;
  issuer?: string | null;
  identifier?: string | null;
  financial_amount?: number | null;
  currency?: string | null;
  created_date?: string | null;
  action_deadline?: string | null;
  action_description?: string | null;
  task_warranted?: boolean;
  extraction_error?: string;
  drafted_task_id?: string;
}

export interface DocumentOut {
  id: string;
  filename: string;
  category: string;
  status: "processing" | "ready" | "needs_review" | string;
  has_actionable_deadline: boolean;
  metadata: DocumentMetadata;
  created_at: string;
  chunk_count: number;
}

export interface UploadResponse {
  document: DocumentOut;
  message: string | null;
  warnings: string[];
}

export interface TaskOut {
  id: string;
  document_id: string | null;
  title: string;
  due_date: string | null;
  status: "pending" | "completed" | string;
  created_at: string;
  source_filename: string | null;
}

export interface Citation {
  chunk_id: string;
  filename: string;
  page_number: number;
  excerpt: string;
}

export interface ToolTrace {
  iteration: number;
  tool_name: string;
  arguments: Record<string, unknown>;
  result_summary: string;
  execution_time_ms: number;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  tool_trace: ToolTrace[];
  iterations: number;
}

export const CATEGORIES = [
  "Insurance",
  "Tax",
  "Vehicle",
  "Utility",
  "Warranty",
  "Rental",
  "General",
] as const;

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.message === "string") return body.message;
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail) && body.detail[0]?.msg) return String(body.detail[0].msg);
  } catch {
    // Body was not JSON (proxy error page, empty 502, ...).
  }
  return `Request failed (${response.status}).`;
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = options;

  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(504, "That took too long. Please retry in a moment.");
    }
    throw new ApiError(0, "Cannot reach the API. Is the backend running on " + API_BASE + "?");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) {
    clearToken();
    throw new ApiError(401, "Your session expired. Please sign in again.");
  }
  if (!response.ok) {
    throw new ApiError(response.status, await parseErrorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// --------------------------------------------------------------------------
// Endpoints
// --------------------------------------------------------------------------

export const api = {
  signup(email: string, password: string) {
    return request<TokenResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  login(email: string, password: string) {
    return request<TokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },

  me() {
    return request<UserOut>("/auth/me");
  },

  listDocuments(category?: string) {
    const query = category && category !== "All" ? `?category=${encodeURIComponent(category)}` : "";
    return request<{ documents: DocumentOut[] }>(`/documents${query}`);
  },

  uploadDocument(file: File) {
    const form = new FormData();
    form.append("file", file);
    return request<UploadResponse>("/documents/upload", {
      method: "POST",
      body: form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  },

  /** Phase 3: async queue — 202 Accepted with job tracking. */
  uploadDocumentAsync(file: File) {
    const form = new FormData();
    form.append("file", file);
    return request<AsyncUploadResponse>("/documents/upload-async", {
      method: "POST",
      body: form,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  },

  deleteDocument(id: string) {
    return request<void>(`/documents/${id}`, { method: "DELETE" });
  },

  /** Filename-bearing viewer URL (token in query; iframes send no headers). */
  documentViewUrl(id: string, filename: string): string | null {
    const token = getToken();
    if (!token) return null;
    return `${API_BASE}/documents/${id}/file/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`;
  },

  /** Fetch the stored PDF as an object URL for the in-app viewer. */
  async documentFileUrl(id: string): Promise<string> {
    const token = getToken();
    const response = await fetch(`${API_BASE}/documents/${id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (response.status === 401) {
      clearToken();
      throw new ApiError(401, "Your session expired. Please sign in again.");
    }
    if (!response.ok) {
      let detail = "Could not open this file.";
      try {
        const body = await response.json();
        if (typeof body?.detail === "string") detail = body.detail;
      } catch {
        // Blob or empty error body — keep the default message.
      }
      throw new ApiError(response.status, detail);
    }
    return URL.createObjectURL(await response.blob());
  },

  chat(message: string, documentId?: string | null) {
    return request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({ message, document_id: documentId ?? null }),
      timeoutMs: CHAT_TIMEOUT_MS,
    });
  },

  listTasks(status?: string) {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return request<TaskOut[]>(`/tasks${query}`);
  },

  updateTaskStatus(id: string, status: "pending" | "completed") {
    return request<TaskOut>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },

  async deleteTask(id: string) {
    await request<void>(`/tasks/${id}`, { method: "DELETE" });
  },

  taskCalendarUrl(id: string) {
    return `${API_BASE}/tasks/${id}/calendar`;
  },

  // --- Phase 2: billing ---

  billingStatus() {
    return request<{
      subscription_tier: string;
      document_count: number;
      free_limit: number;
      razorpay_configured: boolean;
    }>("/billing/status");
  },

  createCheckoutSession() {
    return request<{
      subscription_id: string | null;
      razorpay_key_id: string | null;
      subscription_tier: string;
      message: string;
    }>("/billing/create-checkout-session", { method: "POST" });
  },

  // --- Phase 2: sharing ---

  shareDocument(id: string, shared_with_email: string, permission: "view" | "editor" = "view") {
    return request<ShareOut>(`/documents/${id}/share`, {
      method: "POST",
      body: JSON.stringify({ shared_with_email, permission }),
    });
  },

  listShares(id: string) {
    return request<ShareOut[]>(`/documents/${id}/shares`);
  },

  deleteShare(shareId: string) {
    return request<void>(`/documents/shares/${shareId}`, { method: "DELETE" });
  },

  // --- Phase 2: approvals ---

  listPendingActions() {
    return request<PendingActionOut[]>("/pending-actions");
  },

  decidePendingAction(id: string, decision: "approve" | "reject") {
    return request<PendingActionOut>(`/pending-actions/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  },

  // --- Phase 2: notifications ---

  listNotifications(unreadOnly = false) {
    return request<NotificationOut[]>(`/notifications${unreadOnly ? "?unread_only=true" : ""}`);
  },

  markNotificationRead(id: string) {
    return request<NotificationOut>(`/notifications/${id}/read`, { method: "PATCH" });
  },

  deleteNotification(id: string) {
    return request<void>(`/notifications/${id}`, { method: "DELETE" });
  },

  notificationStreamUrl() {
    const token = getToken();
    return `${API_BASE}/notifications/stream?token=${encodeURIComponent(token ?? "")}`;
  },

  // --- Phase 3: privacy ---

  transparencyLog() {
    return request<TransparencyLog>("/api/privacy/transparency-log");
  },

  purgeAccount() {
    return request<{ status: string; user_id: string }>("/api/user/purge-account", {
      method: "POST",
    });
  },
};

export interface AsyncUploadResponse {
  document_id: string;
  job_id: string;
  status: string;
  correlation_id: string;
}

export interface TransparencyLog {
  stored_in_postgres: {
    account_metadata: string[];
    documents: number;
    chunks_vectors: number;
    audit_logs: number;
    isolation: string;
  };
  sent_to_nvidia_nim: {
    what: string;
    retention: string;
    models: string[];
  };
}

export interface ShareOut {
  id: string;
  document_id: string;
  owner_id: string;
  shared_with_email: string;
  permission: string;
  created_at: string;
}

export interface PendingActionOut {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export interface NotificationOut {
  id: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  due_date: string | null;
  created_at: string;
}
