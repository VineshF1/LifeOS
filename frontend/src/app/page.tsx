"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApprovalModal } from "@/components/ApprovalModal";
import { ChatPane } from "@/components/ChatPane";
import { DeletionModal } from "@/components/DeletionModal";
import { ThemeToggle } from "@/components/theme";
import { DocumentList, CategoryPills } from "@/components/DocumentList";
import { DocumentViewer } from "@/components/DocumentViewer";
import { Dropzone } from "@/components/Dropzone";
import { AnimatedNumber, GlowCard } from "@/components/primitives";
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
  const listScrollRef = useRef<HTMLDivElement>(null);

  /** Scroll-aware edge fades: no top wash at rest, no bottom wash at end. */
  function syncListFade() {
    const el = listScrollRef.current;
    if (!el) return;
    el.classList.toggle("at-top", el.scrollTop <= 4);
    el.classList.toggle(
      "at-bottom",
      el.scrollHeight - el.scrollTop - el.clientHeight <= 4,
    );
  }

  useEffect(() => {
    syncListFade();
  });
  const [shareDocument, setShareDocument] = useState<DocumentOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentOut | null>(null);
  const [viewTarget, setViewTarget] = useState<{ doc: DocumentOut; url: string } | null>(null);

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
      if (next === "completed") toast.success("Task completed.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not update task.");
    } finally {
      setPendingTaskId(null);
    }
  }

  async function deleteTask(task: TaskOut) {
    if (!window.confirm(`Delete task "${task.title}"?`)) return;
    try {
      await api.deleteTask(task.id);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      toast.success("Task deleted.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Could not delete task.");
    }
  }

  function handleUploaded(result: UploadResponse) {
    setDocuments((prev) => [result.document, ...prev]);
    toast.success(`“${result.document.filename}” uploaded — indexing now.`);
    if (result.warnings.length > 0) {
      setNotice(`Saved with warnings: ${result.warnings.join("; ")}`);
    } else if (result.message) {
      setNotice(result.message);
    }
    void loadTasks();
  }

  function openViewer(doc: DocumentOut) {
    const url = api.documentViewUrl(doc.id, doc.filename);
    if (!url) {
      signOut();
      return;
    }
    setViewTarget({ doc, url });
  }

  async function downloadViewing() {
    if (!viewTarget) return;
    try {
      const blobUrl = await api.documentFileUrl(viewTarget.doc.id);
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = viewTarget.doc.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Could not download this file.");
    }
  }

  if (!ready) {
    return (
      <div className="lx-page" style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 420, padding: "1rem" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
            <span className="skel" style={{ width: 36, height: 36, borderRadius: 10 }} />
            <span style={{ flex: 1 }}>
              <span className="skel" style={{ width: "55%", marginBottom: 6 }} />
              <span className="skel" style={{ width: "35%", minHeight: "0.7em" }} />
            </span>
          </div>
          <span className="skel" style={{ minHeight: 120, borderRadius: 12, marginBottom: 10 }} />
          <span className="skel" style={{ width: "60%" }} />
          <p className="lx-hint" style={{ marginTop: 12 }}>Loading your workspace…</p>
        </div>
      </div>
    );
  }

  const filteredDocuments =
    category === "All" ? documents : documents.filter((d) => d.category === category);
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const readyCount = documents.filter((d) => d.status === "ready").length;

  return (
    <div className="lx-page">
      <header className="lx-header">
        <div className="lx-container lx-header-inner">
          <span className="lx-brand">
            <img src="/logo.png" alt="Prova logo" className="logo-img" style={{ width: 28, height: 28 }} />
            Prova
          </span>
          <span style={{ flex: 1 }} />
          <span className="lx-hide-mobile" style={{ color: "var(--ink-2)", fontSize: "0.85rem", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user?.email}
          </span>
          <span className={`lx-badge ${user?.subscription_tier === "pro" ? "lx-badge-gold" : "lx-badge-muted"}`}>
            {user?.subscription_tier === "pro" ? "★ Pro" : "Free"}
          </span>
          <div style={{ position: "relative" }} ref={notifRef}>
            <button
              type="button"
              className="lx-icon-btn"
              title="Notifications"
              aria-label="Notifications"
              aria-expanded={notifOpen}
              onClick={() => {
                const next = !notifOpen;
                setNotifOpen(next);
                if (next) void loadNotifications();
              }}
              style={{ position: "relative" }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {unread > 0 ? (
                <span
                  className="lx-badge lx-badge-red tnum"
                  style={{ position: "absolute", top: -6, right: -8, padding: "0 5px", fontSize: "0.65rem" }}
                >
                  {unread}
                </span>
              ) : null}
            </button>
            {notifOpen ? (
              <div
                className="lx-card"
                style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 360, maxWidth: "90vw", zIndex: 150 }}
                role="dialog"
                aria-label="Notifications"
              >
                <div className="lx-card-head">
                  <h3>Notifications</h3>
                  <span className="spacer">
                    <button
                      type="button"
                      className="lx-btn lx-btn-ghost lx-btn-sm"
                      onClick={() => void loadNotifications()}
                      disabled={notifLoading}
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      className="lx-icon-btn"
                      aria-label="Close notifications"
                      onClick={() => setNotifOpen(false)}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="chat-scroll" style={{ maxHeight: 380, overflowY: "auto", padding: "0.4rem" }}>
                  {notifLoading ? (
                    <div className="lx-hint" style={{ padding: "0.8rem" }}>Loading…</div>
                  ) : notifications.length === 0 ? (
                    <div className="lx-empty">
                      <p className="lx-empty-title">All caught up</p>
                      <p className="lx-empty-sub">Deadline and system alerts land here.</p>
                    </div>
                  ) : (
                    notifications.slice(0, 8).map((item) => (
                      <div
                        key={item.id}
                        className="lx-row"
                        style={item.is_read ? undefined : { background: "var(--accent-soft)" }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {item.title}
                          </span>
                          <span style={{ color: "var(--ink-2)", display: "block", fontSize: 12 }}>
                            {item.message}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 2, flex: "none" }}>
                          {!item.is_read ? (
                            <button
                              type="button"
                              className="lx-icon-btn"
                              title="Mark as read"
                              aria-label={`Mark "${item.title}" as read`}
                              onClick={() => void markNotificationRead(item)}
                            >
                              ✓
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="lx-icon-btn danger"
                            title="Delete"
                            aria-label={`Delete "${item.title}"`}
                            onClick={() => void deleteNotification(item)}
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ padding: "0.7rem 1rem", borderTop: "1px solid var(--line-soft)", textAlign: "right" }}>
                  <a href="/notifications" className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }}>
                    View all
                  </a>
                </div>
              </div>
            ) : null}
          </div>
          <ThemeToggle />
          <a href="/pricing" className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }}>
            Plans
          </a>
          <button type="button" onClick={signOut} className="lx-btn lx-btn-danger-ghost lx-btn-sm" aria-label="Sign out">
            Sign out
          </button>
        </div>
      </header>

      <main className="lx-main">
        <div className="lx-container">
          <div style={{ display: "flex", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
            <div>
              <div className="lx-eyebrow">Personal document agent</div>
              <h2 className="lx-title">Good to see you — here&apos;s your paperwork</h2>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: "1.4rem" }}>
              {[
                { label: "documents", value: documents.length },
                { label: "ready", value: readyCount },
                { label: "pending tasks", value: pendingCount },
              ].map((s) => (
                <div key={s.label} style={{ textAlign: "right" }}>
                  <div className="tnum" style={{ fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.1 }}>
                    <AnimatedNumber value={s.value} />
                  </div>
                  <div className="lx-hint">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {notice ? (
            <div className="lx-alert lx-alert-yellow" role="alert" style={{ marginBottom: "1rem" }}>
              <span style={{ flex: 1 }}>{notice}</span>
              <button
                type="button"
                className="lx-icon-btn"
                aria-label="Dismiss"
                onClick={() => setNotice(null)}
              >
                ×
              </button>
            </div>
          ) : null}

          <div className="lx-grid lx-grid-dash">
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <section className="lx-card">
                <div className="lx-card-head">
                  <h3>Upload</h3>
                  <span className="spacer lx-hint">PDF · ≤25 MB</span>
                </div>
                <div className="lx-card-body">
                  <Dropzone onUploaded={handleUploaded} />
                </div>
              </section>

              <section className="lx-card">
                <div className="lx-card-head">
                  <h3 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Documents · <span className="tnum">{documents.length}</span>
                  </h3>
                  <span className="spacer lx-hint">
                    {documentsLoading ? "loading…" : `${filteredDocuments.length} shown`}
                  </span>
                </div>
                <div className="lx-card-body">
                  <CategoryPills category={category} onCategoryChange={setCategory} />
                  <div
                    ref={listScrollRef}
                    onScroll={syncListFade}
                    className="lx-scrollbareless at-top"
                    style={{ maxHeight: 250 }}
                  >
                    <DocumentList
                      documents={filteredDocuments}
                      loading={documentsLoading}
                      category={category}
                      onCategoryChange={setCategory}
                      hideFilters
                      onSelect={(doc) => {
                        const next = doc.id === scopeDocumentId ? null : doc.id;
                        setScopeDocumentId(next);
                        if (next) {
                          const short =
                            doc.filename.length > 32
                              ? doc.filename.slice(0, 32) + "…"
                              : doc.filename;
                          toast.success(`Chat scoped to ${short}`);
                        } else {
                          toast("Scope cleared — searching all documents.");
                        }
                      }}
                      onDelete={(doc) => setDeleteTarget(doc)}
                      onShare={(doc) => setShareDocument(doc)}
                      onView={(doc) => openViewer(doc)}
                      activeDocumentId={scopeDocumentId}
                    />
                  </div>
                </div>
              </section>
            </div>

            <section className="lx-card" style={{ display: "flex", flexDirection: "column", minHeight: 560 }}>
              <div className="lx-card-head">
                <h3>Ask your documents</h3>
                <span className="spacer">
                  <button
                    type="button"
                    title="Start a new conversation"
                    aria-label="Start a new conversation"
                    onClick={() => setChatKey((key) => key + 1)}
                    className="lx-icon-btn"
                  >
                    +
                  </button>
                </span>
              </div>
              <div style={{ flex: 1, height: "clamp(480px, calc(100vh - 320px), 720px)" }}>
                <ChatPane
                  key={chatKey}
                  documents={documents}
                  scopeDocumentId={scopeDocumentId}
                  onScopeChange={setScopeDocumentId}
                  onSessionExpired={signOut}
                  onRateLimited={() =>
                    toast.warning("Chat rate limit hit (20/min). Slow down a moment.")
                  }
                  onTasksChanged={() => {
                    void loadTasks();
                    void loadApprovals();
                    void loadUnread();
                  }}
                />
              </div>
            </section>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <section className="lx-card">
                <div className="lx-card-head">
                  <h3 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    Tasks · <span className="tnum">{pendingCount}</span> pending
                  </h3>
                  <span className="spacer">
                    <button
                      type="button"
                      title="Reload tasks"
                      aria-label="Reload tasks"
                      onClick={() => void loadTasks()}
                      disabled={tasksLoading}
                      className="lx-icon-btn"
                    >
                      ↻
                    </button>
                  </span>
                </div>
                <div className="lx-card-body">
                  <TaskList
                    tasks={tasks}
                    loading={tasksLoading}
                    onToggle={(task) => void toggleTask(task)}
                    onDelete={(task) => void deleteTask(task)}
                    pendingId={pendingTaskId}
                  />
                </div>
              </section>

              {approvals.length > 0 ? (
                <GlowCard>
                  <div className="lx-card-head" style={{ borderBottom: 0 }}>
                    <h3>Needs your call · {approvals.length}</h3>
                  </div>
                  <div>
                    {approvals.map((approval) => (
                      <button
                        key={approval.id}
                        type="button"
                        className="lx-row"
                        style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer", font: "inherit", color: "inherit" }}
                        onClick={() => setActiveApproval(approval)}
                      >
                        <span style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {String((approval.payload as Record<string, unknown>).title ?? approval.action_type)}
                        </span>
                        <span className="lx-hint">
                          The agent drafted this — tap to review
                        </span>
                      </button>
                    ))}
                  </div>
                </GlowCard>
              ) : null}
            </div>
          </div>
        </div>
      </main>

      {activeApproval ? (
        <ApprovalModal
          action={activeApproval}
          onResolved={(updated) => {
            setActiveApproval(updated);
            if (updated?.status && updated.status !== "pending") {
              toast.success(updated.status === "approved" ? "Action approved." : "Action rejected.");
            }
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

      {deleteTarget ? (
        <DeletionModal
          documentId={deleteTarget.id}
          filename={deleteTarget.filename}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDocuments((prev) => prev.filter((d) => d.id !== deleteTarget.id));
            if (scopeDocumentId === deleteTarget.id) setScopeDocumentId(null);
            toast.success("Document deleted.");
            setDeleteTarget(null);
            void loadTasks();
          }}
        />
      ) : null}

      {viewTarget ? (
        <DocumentViewer
          filename={viewTarget.doc.filename}
          url={viewTarget.url}
          onDownload={() => void downloadViewing()}
          onClose={() => setViewTarget(null)}
        />
      ) : null}
    </div>
  );
}
