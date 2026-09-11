"use client";

import { IconArrowLeft, IconBell, IconCheck, IconTrash } from "@tabler/icons-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, clearToken, getToken, type NotificationOut } from "@/lib/api";
import { openNotificationStream } from "@/lib/sse";
import { formatDate } from "@/lib/utils";

function typeClass(type: string): string {
  if (type === "deadline") return "bg-red-lt";
  if (type === "sharing") return "bg-blue-lt";
  return "bg-muted-lt";
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
    <div className="page">
      <div className="page-wrapper">
        <div className="page-body">
          <div className="container-xl" style={{ maxWidth: 760 }}>
            <Link href="/" className="btn btn-ghost-secondary btn-sm mb-3">
              <IconArrowLeft size={16} className="me-1" />
              Back to dashboard
            </Link>
            <div className="page-pretitle">Alert center</div>
            <h2 className="page-title mb-3">Notifications</h2>
            <p className="text-muted">Documents expiring within 30 days, processing updates, and share invites.</p>
            {notice ? (
              <div className="alert alert-warning" role="alert">
                {notice}
              </div>
            ) : null}
            {loading ? (
              <p className="text-muted">
                <span className="spinner-border spinner-border-sm me-2" role="status" />
                Loading…
              </p>
            ) : items.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">
                  <IconBell size={24} />
                </div>
                <p className="empty-title">All clear</p>
                <p className="empty-subtitle text-muted">No alerts right now.</p>
              </div>
            ) : (
              <div className="list-group">
                {items.map((item) => (
                  <div key={item.id} className={`list-group-item ${item.is_read ? "" : "bg-blue-lt"}`}>
                    <div className="d-flex align-items-start gap-2">
                      <div className="flex-fill" style={{ minWidth: 0 }}>
                        <span className={`badge ${typeClass(item.type)} me-2`}>{item.type}</span>
                        <span className="fw-medium">{item.title}</span>
                        <div className="text-muted" style={{ fontSize: 13 }}>
                          {item.message}
                        </div>
                        <div className="text-muted" style={{ fontSize: 12 }}>
                          {formatDate(item.created_at)}
                          {item.due_date ? ` · due ${formatDate(item.due_date)}` : null}
                        </div>
                      </div>
                      <div className="d-flex gap-1 flex-shrink-0">
                        {!item.is_read ? (
                          <button
                            type="button"
                            className="btn btn-icon btn-sm"
                            title="Mark as read"
                            aria-label={`Mark "${item.title}" as read`}
                            onClick={() => void markRead(item)}
                          >
                            <IconCheck size={14} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn btn-icon btn-sm btn-ghost-danger"
                          title="Delete"
                          aria-label={`Delete "${item.title}"`}
                          onClick={() => void remove(item)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
