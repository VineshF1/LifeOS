"use client";

import { IconCalendarDown, IconInbox, IconTrash } from "@tabler/icons-react";
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
  if (task.status === "completed") return { cls: "bg-green-lt", label: formatDate(task.due_date) };
  const days = daysUntil(task.due_date);
  if (days === null) return { cls: "bg-muted-lt", label: "No deadline" };
  if (days < 0) return { cls: "bg-red-lt", label: `${Math.abs(days)}d overdue` };
  if (days === 0) return { cls: "bg-red-lt", label: "Due today" };
  if (days <= 7) return { cls: "bg-yellow-lt", label: `Due in ${days}d` };
  return { cls: "bg-blue-lt", label: `Due ${formatDate(task.due_date)}` };
}

export function TaskList({ tasks, loading, onToggle, onDelete, pendingId }: TaskListProps) {
  const [calendarError, setCalendarError] = useState<string | null>(null);

  async function downloadCalendar(id: string, title: string) {
    setCalendarError(null);
    try {
      const response = await fetch(api.taskCalendarUrl(id), {
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      });
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
      <div className="card card-body text-muted">
        <span className="spinner-border spinner-border-sm me-2" role="status" />
        Loading tasks…
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <IconInbox size={24} />
        </div>
        <p className="empty-title">No tasks yet</p>
        <p className="empty-subtitle text-muted">
          Deadlines found in an uploaded document appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="list-group">
      {calendarError ? (
        <div className="alert alert-warning mb-2" role="alert">
          {calendarError}
        </div>
      ) : null}
      {tasks.map((task) => {
        const due = dueBadge(task);
        const completed = task.status === "completed";

        return (
          <div key={task.id} className="list-group-item">
            <div className="row align-items-start g-2">
              <div className="col-auto pt-1">
                <input
                  type="checkbox"
                  className="form-check-input m-0"
                  checked={completed}
                  disabled={pendingId === task.id}
                  onChange={() => onToggle(task)}
                  aria-label={completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
                />
              </div>
              <div className="col">
                <span
                  className={`d-block ${completed ? "text-muted text-decoration-line-through" : "fw-medium"}`}
                >
                  {pendingId === task.id ? (
                    <span className="spinner-border spinner-border-sm me-2" role="status" />
                  ) : null}
                  {task.title}
                </span>
                <span className="d-flex flex-wrap align-items-center gap-2 mt-1">
                  <span className={`badge ${due.cls}`}>{due.label}</span>
                  {task.source_filename ? (
                    <span className="text-muted text-truncate" style={{ fontSize: 12, maxWidth: 180 }} title={task.source_filename}>
                      {task.source_filename}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="col-auto d-flex gap-1">
                <button
                  type="button"
                  title={`Download calendar file for ${task.title} (Pro)`}
                  className="btn btn-icon btn-sm"
                  onClick={() => void downloadCalendar(task.id, task.title)}
                >
                  <IconCalendarDown size={16} />
                </button>
                <button
                  type="button"
                  title={`Delete ${task.title}`}
                  onClick={() => onDelete(task)}
                  className="btn btn-icon btn-sm btn-ghost-danger"
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
