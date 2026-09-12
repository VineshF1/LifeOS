"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { ApiError, api } from "@/lib/api";

export function DeletionModal({
  documentId,
  filename,
  onDeleted,
  onClose,
}: {
  documentId: string;
  filename: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteDocument(documentId);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lx-overlay" role="dialog" aria-modal="true">
      <div className="lx-modal sm" role="document">
        <motion.div
          className="modal-content"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="lx-modal-head">
            <h5>{step === 1 ? "Delete document?" : "Final confirmation"}</h5>
            <button type="button" className="lx-icon-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="lx-modal-body">
            {step === 1 ? (
              <p style={{ color: "var(--ink-2)" }}>
                <strong>{filename}</strong> and all its vectors, shares, and drafted tasks will be
                permanently removed. Any running ingestion is cancelled first.
              </p>
            ) : (
              <p style={{ color: "var(--red)" }}>
                This cannot be undone. The file, its embeddings, and related tasks will be hard-deleted.
              </p>
            )}
            {error && <div className="lx-alert lx-alert-red">{error}</div>}
          </div>
          <div className="lx-modal-foot">
            <button className="lx-btn lx-btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {step === 1 ? (
              <button className="lx-btn lx-btn-danger" onClick={() => setStep(2)}>
                Continue
              </button>
            ) : (
              <button className="lx-btn lx-btn-danger" onClick={confirmDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            )}
          </div>
      </motion.div>
      </div>
    </div>
  );
}
