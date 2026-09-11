"use client";

import { IconCheck, IconShieldCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { ApiError, api, type PendingActionOut } from "@/lib/api";
import { formatDate } from "@/lib/utils";

interface ApprovalModalProps {
  action: PendingActionOut;
  onResolved: (action: PendingActionOut | null) => void;
  onError: (message: string) => void;
}

/**
 * Human-in-the-loop confirmation dialog. Shows the drafted payload, waits for
 * an explicit decision — never a spinner implying the agent is still working.
 */
export function ApprovalModal({ action, onResolved, onError }: ApprovalModalProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const payload = action.payload as Record<string, string | null>;

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    try {
      const updated = await api.decidePendingAction(action.id, decision);
      onResolved(updated.status === "pending" ? updated : null);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Could not record your decision.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal modal-blur show d-block" role="dialog" aria-modal="true" aria-label="Approve agent action">
      <div className="modal-dialog modal-dialog-centered" role="document">
        <div className="modal-content">
          <div className="modal-header">
            <span className="avatar avatar-sm rounded bg-yellow-lt me-2">
              <IconShieldCheck size={16} />
            </span>
            <h5 className="modal-title">Agent wants your approval</h5>
            <button type="button" className="btn-close" aria-label="Dismiss" onClick={() => onResolved(action)} />
          </div>
          <div className="modal-body">
            <p className="mb-2">
              The agent drafted <strong>{String(payload.title ?? action.action_type)}</strong>
              {payload.due_date ? (
                <>
                  {" "}due <strong>{formatDate(String(payload.due_date))}</strong>
                </>
              ) : null}
              . Nothing is committed until you confirm.
            </p>
            <div className="datagrid">
              <div className="datagrid-item">
                <div className="datagrid-title">Action</div>
                <div className="datagrid-content">{action.action_type}</div>
              </div>
              <div className="datagrid-item">
                <div className="datagrid-title">Expires</div>
                <div className="datagrid-content">{action.expires_at ? formatDate(action.expires_at) : "—"}</div>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-ghost-danger"
              disabled={busy !== null}
              onClick={() => void decide("reject")}
            >
              {busy === "reject" ? (
                <span className="spinner-border spinner-border-sm me-2" role="status" />
              ) : (
                <IconX size={16} className="me-1" />
              )}
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void decide("approve")}
            >
              {busy === "approve" ? (
                <span className="spinner-border spinner-border-sm me-2" role="status" />
              ) : (
                <IconCheck size={16} className="me-1" />
              )}
              Approve
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
