"use client";

import { IconCalendarDown, IconInbox, IconTrash } from "@tabler/icons-react";
import { motion } from "motion/react";
import { useState } from "react";
import { ApiError, api, getToken, type TaskOut } from "@/lib/api";
import { daysUntil, formatDate } from "@/lib/utils";

interface TaskListProps {
  tasks: TaskOut[];
  loading: boolean;
  onToggle: (task: TaskOut) => void;
  onDelete: (task: TaskOut) => void;
  pendingId: string | null;
}

function dueBadge(task: TaskOut): { cls: string; label: string } {
  if (task.status === "completed") return { cls: "lx-badge-green", label: formatDate(task.due_date) };
  const days = daysUntil(task.due_date);
  if (days === null) return { cls: "lx-badge-muted", label: "No deadline" };
  if (days < 0) return { cls: "lx-badge-red", label: `${Math.abs(days)}d overdue` };
  if (days === 0) return { cls: "lx-badge-red", label: "Due today" };
  if (days <= 7) return { cls: "lx-badge-yellow", label: `Due in ${days}d` };
  return { cls: "lx-badge-blue", label: `Due ${formatDate(task.due_date)}` };
}

export function TaskList({ tasks, loading, onToggle, onDelete, pendingId }: TaskListProps) {
  const [calendarError, setCalendarError] = useState<string | null>(null);

  async function downloadCalendar(id: string, title: string) {
    setCalendarError(null);
    try {
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers["Authorization"] = "Bearer " + token;
      const response = await fetch(api.taskCalendarUrl(id), { headers });
      if (!response.ok) {
        let detail = `Download failed (${response.status}).`;
        try {
          const body = await response.json();
          if (typeof body?.detail === "string") detail = body.detail;
          else if (typeof body?.message === "string") detail = body.message;
        } catch {
          // Non-JSON error page.
        }
        throw new ApiError(response.status, detail);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `lifeos-task-${id}.ics`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setCalendarError(e instanceof ApiError ? e.message : `Could not download calendar file for "${title}".`);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label="Loading tasks">
        {[0, 1].map((i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="skel" style={{ width: 20, height: 20, borderRadius: 6 }} />
            <span style={{ flex: 1 }}>
              <span className="skel" style={{ width: "80%", marginBottom: 6 }} />
              <span className="skel" style={{ width: "40%", minHeight: "0.7em" }} />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="lx-empty">
        <div>
          <span className="lx-avatar soft-green" style={{ width: 44, height: 44 }}>
            <IconInbox size={22} />
          </span>
        </div>
        <p className="lx-empty-title">All clear</p>
        <p className="lx-empty-sub">
          Deadlines found in your documents will appear here on their own.
        </p>
      </div>
    );
  }

  return (
    <div>
      {calendarError ? (
        <div className="lx-alert lx-alert-yellow" role="alert" style={{ marginBottom: "0.6rem" }}>
          {calendarError}
        </div>
      ) : null}
      {tasks.map((task, index) => {
        const due = dueBadge(task);
        const completed = task.status === "completed";

        return (
          <motion.div
            key={task.id}
            className="lx-row"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1], delay: Math.min(index, 5) * 0.04 }}
            layout
          >
            <div style={{ paddingTop: 2 }}>
              <button
                type="button"
                role="checkbox"
                aria-checked={completed}
                aria-label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
                disabled={pendingId === task.id}
                onClick={() => onToggle(task)}
                className={`task-check ${completed ? "task-check-done" : ""}`}
              >
                {completed ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path d="M2 6.5 4.8 9 10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontWeight: completed ? 400 : 600,
                  color: completed ? "var(--ink-3)" : undefined,
                  textDecoration: completed ? "line-through" : undefined,
                }}
              >
                {task.title}
              </span>
              <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 4 }}>
                <span className={`lx-badge ${due.cls}`}>{due.label}</span>
                {task.source_filename ? (
                  <span
                    style={{ color: "var(--ink-2)", fontSize: 12, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={task.source_filename}
                  >
                    {task.source_filename}
                  </span>
                ) : null}
              </span>
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button
                type="button"
                title={`Download calendar file for ${task.title} (Pro)`}
                aria-label={`Download calendar file for ${task.title}`}
                className="lx-icon-btn"
                onClick={() => void downloadCalendar(task.id, task.title)}
              >
                <IconCalendarDown size={16} />
              </button>
              <button
                type="button"
                title={`Delete ${task.title}`}
                aria-label={`Delete ${task.title}`}
                onClick={() => onDelete(task)}
                className="lx-icon-btn danger"
              >
                <IconTrash size={16} />
              </button>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
