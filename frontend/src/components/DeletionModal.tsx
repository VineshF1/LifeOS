"use client";

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
    <div className="modal modal-blur fade show d-block" role="dialog" aria-modal="true">
      <div className="modal-dialog modal-sm modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">{step === 1 ? "Delete document?" : "Final confirmation"}</h5>
            <button type="button" className="btn-close" onClick={onClose} aria-label="Close" />
          </div>
          <div className="modal-body">
            {step === 1 ? (
              <p className="text-muted">
                <strong>{filename}</strong> and all its vectors, shares, and drafted tasks will be
                permanently removed. Any running ingestion is cancelled first.
              </p>
            ) : (
              <p className="text-danger">
                This cannot be undone. The file, its embeddings, and related tasks will be hard-deleted.
              </p>
            )}
            {error && <div className="alert alert-danger py-2">{error}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn btn-link" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {step === 1 ? (
              <button className="btn btn-danger" onClick={() => setStep(2)}>
                Continue
              </button>
            ) : (
              <button className="btn btn-danger" onClick={confirmDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
