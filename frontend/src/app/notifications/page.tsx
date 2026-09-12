"use client";

import { IconArrowLeft, IconBell, IconCheck, IconTrash } from "@tabler/icons-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, clearToken, getToken, type NotificationOut } from "@/lib/api";
import { openNotificationStream } from "@/lib/sse";
import { formatDate } from "@/lib/utils";

function typeClass(type: string): string {
  if (type === "deadline") return "lx-badge-red";
  if (type === "sharing") return "lx-badge-blue";
  return "lx-badge-muted";
}

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.listNotifications());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        router.replace("/login");
        return;
      }
      setNotice(e instanceof ApiError ? e.message : "Could not load notifications.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    void load();
    const stream = openNotificationStream({
      onReady: (payload) => {
        if (payload.new_deadlines > 0) void load();
      },
      onHeartbeat: () => {},
      onError: () => {},
    });
    return () => stream?.close();
  }, [router, load]);

  async function markRead(item: NotificationOut) {
    try {
      const updated = await api.markNotificationRead(item.id);
      setItems((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not update notification.");
    }
  }

  async function remove(item: NotificationOut) {
    try {
      await api.deleteNotification(item.id);
      setItems((prev) => prev.filter((n) => n.id !== item.id));
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Could not delete notification.");
    }
  }

  return (
    <div className="lx-page">
      <main className="lx-main">
        <div className="lx-container" style={{ maxWidth: 760 }}>
            <Link href="/" className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none", marginBottom: "1rem" }}>
              <IconArrowLeft size={16} />
              Back to dashboard
            </Link>
            <div className="lx-eyebrow">Alert center</div>
            <h2 className="lx-title" style={{ marginBottom: "0.3rem" }}>Notifications</h2>
            <p className="lx-sub" style={{ marginBottom: "1.25rem" }}>Documents expiring within 30 days, processing updates, and share invites.</p>
            {notice ? (
              <div className="lx-alert lx-alert-yellow" role="alert" style={{ marginBottom: "1rem" }}>
                {notice}
              </div>
            ) : null}
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Loading notifications">
                {[0, 1, 2].map((i) => (
                  <div key={i}>
                    <span className="skel" style={{ width: "55%", marginBottom: 4 }} />
                    <span className="skel" style={{ width: "85%", minHeight: "0.8em" }} />
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="lx-empty">
                <div>
                  <span className="lx-avatar soft-green" style={{ width: 44, height: 44 }}>
                    <IconBell size={22} />
                  </span>
                </div>
                <p className="lx-empty-title">All clear</p>
                <p className="lx-empty-sub">
                  Deadline alerts, processing updates, and share invites land here.
                </p>
              </div>
            ) : (
              <div>
                {items.map((item, index) => (
                  <motion.div
                    key={item.id}
                    className="lx-row" style={item.is_read ? undefined : { background: "var(--accent-soft)" }}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1], delay: Math.min(index, 6) * 0.04 }}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span className={`lx-badge ${typeClass(item.type)}`} style={{ marginRight: 8 }}>{item.type}</span>
                        <span style={{ fontWeight: 600 }}>{item.title}</span>
                        <div style={{ color: "var(--ink-2)", fontSize: 13 }}>
                          {item.message}
                        </div>
                        <div className="lx-hint">
                          {formatDate(item.created_at)}
                          {item.due_date ? ` · due ${formatDate(item.due_date)}` : null}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 4, flex: "none" }}>
                        {!item.is_read ? (
                          <button
                            type="button"
                            className="lx-icon-btn"
                            title="Mark as read"
                            aria-label={`Mark "${item.title}" as read`}
                            onClick={() => void markRead(item)}
                          >
                            <IconCheck size={14} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="lx-icon-btn danger"
                          title="Delete"
                          aria-label={`Delete "${item.title}"`}
                          onClick={() => void remove(item)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
        </div>
      </main>
    </div>
  );
}
