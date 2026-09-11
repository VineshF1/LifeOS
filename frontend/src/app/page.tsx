"use client";

import {
  IconBell,
  IconCheck,
  IconCrown,
  IconFileText,
  IconLogout,
  IconMessageChatbot,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
} from "@tabler/icons-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApprovalModal } from "@/components/ApprovalModal";
import { ChatPane } from "@/components/ChatPane";
import { DocumentList } from "@/components/DocumentList";
import { Dropzone } from "@/components/Dropzone";
import { ShareDialog } from "@/components/ShareDialog";
import { TaskList } from "@/components/TaskList";
import {
  ApiError,
  api,
  clearToken,
  getToken,
  type DocumentOut,
  type NotificationOut,
  type PendingActionOut,
  type TaskOut,
  type UploadResponse,
  type UserOut,
} from "@/lib/api";

export default function DashboardPage() {
  const router = useRouter();

  const [user, setUser] = useState<UserOut | null>(null);
  const [ready, setReady] = useState(false);
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [tasks, setTasks] = useState<TaskOut[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [category, setCategory] = useState("All");
  const [scopeDocumentId, setScopeDocumentId] = useState<string | null>(null);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [approvals, setApprovals] = useState<PendingActionOut[]>([]);
  const [activeApproval, setActiveApproval] = useState<PendingActionOut | null>(null);
  const [unread, setUnread] = useState(0);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationOut[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const [shareDocument, setShareDocument] = useState<DocumentOut | null>(null);

  const signOut = useCallback(() => {
    clearToken();
    router.replace("/login");
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    api
      .me()
      .then((p) => {
        if (!cancelled) {
          setUser(p);
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) signOut();
      });
    return () => {
      cancelled = true;
    };
  }, [router, signOut]);

  const loadDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    try {
      const r = await api.listDocuments();
      setDocuments(r.documents);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut();
      else setNotice(e instanceof ApiError ? e.message : "Could not load documents.");
    } finally {
      setDocumentsLoading(false);
    }
  }, [signOut]);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      setTasks(await api.listTasks());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) signOut();
      else setNotice(e instanceof ApiError ? e.message : "Could not load tasks.");
    } finally {
      setTasksLoading(false);
    }
  }, [signOut]);

  const loadApprovals = useCallback(async () => {
    try {
      const rows = await api.listPendingActions();
      setApprovals(rows);
      setActiveApproval((current) =>
        current ? (rows.find((r) => r.id === current.id) ?? null) : (rows[0] ?? null),
      );
    } catch {
      // Approvals are non-blocking; the badge simply stays empty.
    }
  }, []);

  const loadUnread = useCallback(async () => {
    try {
      const rows: NotificationOut[] = await api.listNotifications(true);
      setUnread(rows.length);
    } catch {
      // Non-blocking.
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    setNotifLoading(true);
    try {
      const rows: NotificationOut[] = await api.listNotifications();
      setNotifications(rows);
      setUnread(rows.filter((n) => !n.is_read).length);
    } catch {
      // Non-blocking; dropdown simply shows empty state.
    } finally {
      setNotifLoading(false);
    }
  }, []);

  // Close the notifications dropdown on outside click / Escape — it never navigates.
  useEffect(() => {
    if (!notifOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setNotifOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [notifOpen]);

  async function markNotificationRead(item: NotificationOut) {
    try {
      const updated = await api.markNotificationRead(item.id);
      setNotifications((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setUnread((prev) => Math.max(0, prev - (item.is_read ? 0 : 1)));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not update notification.");
    }
  }

  async function deleteNotification(item: NotificationOut) {
    try {
      await api.deleteNotification(item.id);
      setNotifications((prev) => prev.filter((n) => n.id !== item.id));
      if (!item.is_read) setUnread((prev) => Math.max(0, prev - 1));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not delete notification.");
    }
  }

  useEffect(() => {
    if (ready) {
      void loadDocuments();
      void loadTasks();
      void loadApprovals();
      void loadUnread();
    }
  }, [ready, loadDocuments, loadTasks, loadApprovals, loadUnread]);

  async function toggleTask(task: TaskOut) {
    setPendingTaskId(task.id);
    try {
      const next = task.status === "completed" ? "pending" : "completed";
      const updated = await api.updateTaskStatus(task.id, next);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not update task.");
    } finally {
      setPendingTaskId(null);
    }
  }

  async function deleteTask(task: TaskOut) {
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await api.deleteTask(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not delete task.");
    }
  }

  async function deleteDocument(document: DocumentOut) {
    if (!window.confirm(`Delete ${document.filename}?`)) return;
    try {
      await api.deleteDocument(document.id);
      setDocuments((prev) => prev.filter((d) => d.id !== document.id));
      if (scopeDocumentId === document.id) setScopeDocumentId(null);
      // The backend deletes the document's tasks too — reload so orphans vanish.
      void loadTasks();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not delete document.");
    }
  }

  function handleUploaded(result: UploadResponse) {
    setDocuments((prev) => [result.document, ...prev]);
    if (result.warnings.length > 0) {
      setNotice(`Saved with warnings: ${result.warnings.join("; ")}`);
    } else if (result.message) {
      setNotice(result.message);
    }
    void loadTasks();
  }

  if (!ready) {
    return (
      <div className="page page-center">
        <div className="container container-tight py-4 text-center">
          <span className="spinner-border" role="status" />
          <p className="text-muted mt-2 mb-0">Loading LifeOS…</p>
        </div>
      </div>
    );
  }

  const filteredDocuments =
    category === "All" ? documents : documents.filter((d) => d.category === category);
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const readyCount = documents.filter((d) => d.status === "ready").length;

  return (
    <div className="page">
      <header className="navbar navbar-expand-md d-print-none">
        <div className="container-xl">
          <h1 className="navbar-brand navbar-brand-autodark d-none-navbar-horizontal pe-0 pe-md-3">
            <span className="avatar avatar-sm rounded me-2" style={{ background: "var(--tblr-primary)" }}>
              <IconFileText size={18} color="#fff" />
            </span>
            LifeOS Agent
          </h1>
          <div className="navbar-nav flex-row order-md-last align-items-center">
            {/* Plain inline flex row (no Tabler nav-item class): Tabler forces
                nav-items into a column, which stacked the badge under the email. */}
            <div
              className="d-none d-md-flex me-3"
              style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, whiteSpace: "nowrap", flexWrap: "nowrap" }}
            >
              <span className="text-muted text-truncate" style={{ maxWidth: 220 }}>{user?.email}</span>
              <span
                className={`badge flex-shrink-0 mb-0 ${user?.subscription_tier === "pro" ? "bg-green-lt" : "bg-muted-lt"}`}
                style={{ display: "inline-flex", alignItems: "center", flexDirection: "row", whiteSpace: "nowrap" }}
              >
                {user?.subscription_tier === "pro" ? (
                  <>
                    <IconCrown size={12} className="me-1" />
                    Pro
                  </>
                ) : (
                  "Free"
                )}
              </span>
            </div>
            <div className="nav-item me-2 position-relative" ref={notifRef}>
              <button
                type="button"
                className="btn btn-sm btn-icon position-relative"
                title="Notifications"
                aria-label="Notifications"
                aria-expanded={notifOpen}
                onClick={() => {
                  const next = !notifOpen;
                  setNotifOpen(next);
                  if (next) void loadNotifications();
                }}
              >
                <IconBell size={16} />
                {unread > 0 ? (
                  <span className="badge bg-red position-absolute top-0 start-100 translate-middle rounded-pill">
                    {unread}
                  </span>
                ) : null}
              </button>
              {notifOpen ? (
                <div
                  className="card position-absolute end-0 mt-2 shadow"
                  style={{ width: 360, maxWidth: "90vw", zIndex: 1050 }}
                  role="dialog"
                  aria-label="Notifications"
                >
                  <div className="card-header d-flex align-items-center">
                    <h3 className="card-title mb-0">Notifications</h3>
                    <div className="card-actions ms-auto d-flex gap-1">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void loadNotifications()}
                        disabled={notifLoading}
                      >
                        Refresh
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon"
                        aria-label="Close notifications"
                        onClick={() => setNotifOpen(false)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="list-group list-group-flush" style={{ maxHeight: 380, overflowY: "auto" }}>
                    {notifLoading ? (
                      <div className="list-group-item text-muted">Loading…</div>
                    ) : notifications.length === 0 ? (
                      <div className="list-group-item text-muted">No alerts right now.</div>
                    ) : (
                      notifications.slice(0, 8).map((item) => (
                        <div key={item.id} className={`list-group-item ${item.is_read ? "" : "bg-blue-lt"}`}>
                          <div className="d-flex align-items-start gap-2">
                            <div className="flex-fill" style={{ minWidth: 0 }}>
                              <span className="fw-medium d-block text-truncate">{item.title}</span>
                              <span className="text-muted d-block" style={{ fontSize: 12 }}>
                                {item.message}
                              </span>
                            </div>
                            <div className="d-flex gap-1 flex-shrink-0">
                              {!item.is_read ? (
                                <button
                                  type="button"
                                  className="btn btn-icon btn-sm"
                                  title="Mark as read"
                                  aria-label={`Mark "${item.title}" as read`}
                                  onClick={() => void markNotificationRead(item)}
                                >
                                  <IconCheck size={14} />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="btn btn-icon btn-sm btn-ghost-danger"
                                title="Delete"
                                aria-label={`Delete "${item.title}"`}
                                onClick={() => void deleteNotification(item)}
                              >
                                <IconTrash size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="card-footer text-end">
                    <Link href="/notifications" className="btn btn-sm btn-ghost-secondary">
                      View all
                    </Link>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="nav-item me-2">
              <Link href="/pricing" className="btn btn-sm">
                Pricing
              </Link>
            </div>
            <div className="nav-item">
              <button type="button" onClick={signOut} className="btn btn-sm btn-ghost-danger">
                <IconLogout size={16} className="me-1" />
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="page-wrapper">
        <div className="page-header d-print-none">
          <div className="container-xl">
            <div className="row g-2 align-items-center">
              <div className="col">
                <div className="page-pretitle">Personal document agent</div>
                <h2 className="page-title">Your documents, turned into action</h2>
              </div>
              <div className="col-auto ms-auto d-print-none">
                <div className="btn-list">
                  <span className="badge bg-blue-lt">{documents.length} documents</span>
                  <span className="badge bg-green-lt">{readyCount} ready</span>
                  <span className="badge bg-yellow-lt">{pendingCount} pending tasks</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="page-body">
          <div className="container-xl">
            {notice ? (
              <div className="alert alert-warning alert-dismissible" role="alert">
                {notice}
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Dismiss"
                  onClick={() => setNotice(null)}
                />
              </div>
            ) : null}

            <div className="row row-deck row-cards">
              <div className="col-lg-4 d-flex flex-column gap-3">
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">Upload</h3>
                  </div>
                  <div className="card-body">
                    <Dropzone onUploaded={handleUploaded} />
                  </div>
                </div>

                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title text-truncate" style={{ minWidth: 0 }}>
                      Documents · {documents.length}
                    </h3>
                    <div
                      className="card-actions text-muted flex-shrink-0 ms-2"
                      style={{ fontSize: 12 }}
                    >
                      {documentsLoading ? "loading…" : `${filteredDocuments.length} shown`}
                    </div>
                  </div>
                  <div className="card-body">
                    <div style={{ maxHeight: 420, overflowY: "auto" }} className="chat-scroll">
                      <DocumentList
                        documents={filteredDocuments}
                        loading={documentsLoading}
                        category={category}
                        onCategoryChange={setCategory}
                        onSelect={(doc) =>
                          setScopeDocumentId(doc.id === scopeDocumentId ? null : doc.id)
                        }
                        onDelete={(doc) => void deleteDocument(doc)}
                        onShare={(doc) => setShareDocument(doc)}
                        activeDocumentId={scopeDocumentId}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="col-lg-5">
                <div className="card d-flex flex-column" style={{ minHeight: 560 }}>
                  <div className="card-header">
                    <span className="avatar avatar-xs rounded bg-blue-lt me-2">
                      <IconMessageChatbot size={14} />
                    </span>
                    <h3 className="card-title">Ask your documents</h3>
                    <div className="card-actions">
                      <button
                        type="button"
                        title="Start a new conversation"
                        aria-label="Start a new conversation"
                        onClick={() => setChatKey((key) => key + 1)}
                        className="btn btn-icon btn-sm"
                      >
                        <IconPlus size={16} />
                      </button>
                    </div>
                  </div>
                  <div
                    className="flex-fill"
                    style={{ height: "clamp(480px, calc(100vh - 320px), 720px)" }}
                  >
                    <ChatPane
                      key={chatKey}
                      documents={documents}
                      scopeDocumentId={scopeDocumentId}
                      onScopeChange={setScopeDocumentId}
                      onSessionExpired={signOut}
                      onTasksChanged={() => {
                        void loadTasks();
                        void loadApprovals();
                        void loadUnread();
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="col-lg-3 d-flex flex-column gap-3">
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title text-truncate" style={{ minWidth: 0 }}>
                      Tasks · {pendingCount} pending
                    </h3>
                    <div className="card-actions">
                      <button
                        type="button"
                        title="Reload tasks"
                        aria-label="Reload tasks"
                        onClick={() => void loadTasks()}
                        disabled={tasksLoading}
                        className="btn btn-icon btn-sm"
                      >
                        <IconRefresh size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="card-body">
                    <TaskList
                      tasks={tasks}
                      loading={tasksLoading}
                      onToggle={(task) => void toggleTask(task)}
                      onDelete={(task) => void deleteTask(task)}
                      pendingId={pendingTaskId}
                    />
                  </div>
                </div>

                {approvals.length > 0 ? (
                  <div className="card">
                    <div className="card-header">
                      <span className="avatar avatar-xs rounded bg-yellow-lt me-2">
                        <IconShieldCheck size={14} />
                      </span>
                      <h3 className="card-title">Awaiting approval · {approvals.length}</h3>
                    </div>
                    <div className="list-group list-group-flush">
                      {approvals.map((approval) => (
                        <button
                          key={approval.id}
                          type="button"
                          className="list-group-item list-group-item-action"
                          onClick={() => setActiveApproval(approval)}
                        >
                          <span className="fw-medium d-block text-truncate">
                            {String((approval.payload as Record<string, unknown>).title ?? approval.action_type)}
                          </span>
                          <span className="text-muted" style={{ fontSize: 12 }}>
                            Agent drafted this — tap to review
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {activeApproval ? (
        <ApprovalModal
          action={activeApproval}
          onResolved={(updated) => {
            setActiveApproval(updated);
            void loadApprovals();
            void loadTasks();
          }}
          onError={(message) => setNotice(message)}
        />
      ) : null}

      {shareDocument ? (
        <ShareDialog
          document={shareDocument}
          onClose={() => setShareDocument(null)}
          onError={(message) => setNotice(message)}
        />
      ) : null}
    </div>
  );
}
