"use client";

import { IconShare, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { ApiError, api, type DocumentOut, type ShareOut } from "@/lib/api";

interface ShareDialogProps {
  document: DocumentOut;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Pro-only document sharing with view/editor permission selector. */
export function ShareDialog({ document, onClose, onError }: ShareDialogProps) {
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"view" | "editor">("view");
  const [shares, setShares] = useState<ShareOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listShares(document.id)
      .then((rows) => {
        if (!cancelled) setShares(rows);
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof ApiError ? e.message : "Could not load shares.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.id]);

  async function share() {
    if (!email.trim()) return;
    setSaving(true);
    try {
      const created = await api.shareDocument(document.id, email.trim(), permission);
      setShares((prev) => [created, ...prev]);
      setEmail("");
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Could not share this document.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(share: ShareOut) {
    try {
      await api.deleteShare(share.id);
      setShares((prev) => prev.filter((s) => s.id !== share.id));
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Could not remove this share.");
    }
  }

  return (
    <div className="modal modal-blur show d-block" role="dialog" aria-modal="true" aria-label="Share document">
      <div className="modal-dialog modal-dialog-centered" role="document">
        <div className="modal-content">
          <div className="modal-header">
            <span className="avatar avatar-sm rounded bg-blue-lt me-2">
              <IconShare size={16} />
            </span>
            <h5 className="modal-title text-truncate">Share {document.filename}</h5>
            <button type="button" className="btn-close" aria-label="Close" onClick={onClose} />
          </div>
          <div className="modal-body">
            <div className="row g-2">
              <div className="col">
                <input
                  type="email"
                  className="form-control"
                  placeholder="family@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Email to share with"
                />
              </div>
              <div className="col-auto">
                <select
                  className="form-select"
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as "view" | "editor")}
                  aria-label="Permission"
                >
                  <option value="view">View</option>
                  <option value="editor">Editor</option>
                </select>
              </div>
              <div className="col-auto">
                <button type="button" className="btn btn-primary" disabled={saving || !email.trim()} onClick={() => void share()}>
                  {saving ? <span className="spinner-border spinner-border-sm" role="status" /> : "Share"}
                </button>
              </div>
            </div>

            <div className="mt-3">
              {loading ? (
                <p className="text-muted mb-0">
                  <span className="spinner-border spinner-border-sm me-2" role="status" />
                  Loading shares…
                </p>
              ) : shares.length === 0 ? (
                <p className="text-muted mb-0">Not shared with anyone yet.</p>
              ) : (
                <div className="list-group">
                  {shares.map((share) => (
                    <div key={share.id} className="list-group-item">
                      <div className="d-flex align-items-center gap-2">
                        <div className="flex-fill text-truncate">
                          <span className="fw-medium">{share.shared_with_email}</span>{" "}
                          <span className="badge bg-blue-lt">{share.permission}</span>
                        </div>
                        <button
                          type="button"
                          className="btn btn-icon btn-sm btn-ghost-danger"
                          aria-label={`Remove share with ${share.shared_with_email}`}
                          onClick={() => void remove(share)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              <IconX size={16} className="me-1" />
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
