"use client";

import { IconShieldCheck } from "@tabler/icons-react";
import { motion } from "motion/react";
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
    <div className="lx-overlay" role="dialog" aria-modal="true" aria-label="Approve agent action">
      <div className="lx-modal" role="document">
        <motion.div
          className="modal-content"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="lx-modal-head">
            <span className="lx-avatar soft-yellow" style={{ width: 32, height: 32 }}>
              <IconShieldCheck size={16} />
            </span>
            <h5>Agent wants your approval</h5>
            <button type="button" className="lx-icon-btn" aria-label="Dismiss" onClick={() => onResolved(action)}>×</button>
          </div>
          <div className="lx-modal-body">
            <p style={{ marginBottom: "0.8rem" }}>
              The agent drafted <strong>{String(payload.title ?? action.action_type)}</strong>
              {payload.due_date ? (
                <>
                  {" "}due <strong>{formatDate(String(payload.due_date))}</strong>
                </>
              ) : null}
              . Nothing is committed until you confirm.
            </p>
            <dl className="lx-datagrid">
              <div>
                <dt>Action</dt>
                <dd>{action.action_type}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{action.expires_at ? formatDate(action.expires_at) : "—"}</dd>
              </div>
            </dl>
          </div>
          <div className="lx-modal-foot">
            <button
              type="button"
              className="lx-btn lx-btn-danger-ghost"
              disabled={busy !== null}
              onClick={() => void decide("reject")}
            >
              {busy === "reject" ? (
                <span className="lx-spinner sm" role="status" style={{ marginRight: 8 }} />
              ) : null}
              Reject
            </button>
            <button
              type="button"
              className="lx-btn lx-btn-primary"
              disabled={busy !== null}
              onClick={() => void decide("approve")}
            >
              {busy === "approve" ? (
                <span className="lx-spinner sm" role="status" style={{ marginRight: 8 }} />
              ) : null}
              Approve
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
