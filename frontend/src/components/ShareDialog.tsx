"use client";

import { IconShare, IconTrash, IconX } from "@tabler/icons-react";
import { motion } from "motion/react";
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
    <div className="lx-overlay" role="dialog" aria-modal="true" aria-label="Share document">
      <div className="lx-modal" role="document">
        <motion.div
          className="modal-content"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="lx-modal-head">
            <span className="lx-avatar soft-blue" style={{ width: 30, height: 30 }}>
              <IconShare size={16} />
            </span>
            <h5 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Share {document.filename}</h5>
            <button type="button" className="lx-icon-btn" aria-label="Close" onClick={onClose}>×</button>
          </div>
          <div className="lx-modal-body">
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="email"
                  className="lx-input"
                  placeholder="family@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Email to share with"
                />
              </div>
              <div>
                <select
                  className="lx-select"
                  value={permission}
                  onChange={(e) => setPermission(e.target.value as "view" | "editor")}
                  aria-label="Permission"
                >
                  <option value="view">View</option>
                  <option value="editor">Editor</option>
                </select>
              </div>
              <div>
                <button type="button" className="lx-btn lx-btn-primary" disabled={saving || !email.trim()} onClick={() => void share()}>
                  {saving ? <span className="lx-spinner sm" role="status" /> : "Share"}
                </button>
              </div>
            </div>

            <div className="mt-3">
              {loading ? (
                <p style={{ color: "var(--ink-2)", margin: 0 }}>
                  <span className="lx-spinner sm" role="status" style={{ marginRight: 8 }} />
                  Loading shares…
                </p>
              ) : shares.length === 0 ? (
                <p style={{ color: "var(--ink-2)", margin: 0 }}>Not shared with anyone yet.</p>
              ) : (
                <div>
                  {shares.map((share) => (
                    <div key={share.id} className="lx-row">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ fontWeight: 600 }}>{share.shared_with_email}</span>{" "}
                          <span className="lx-badge lx-badge-blue">{share.permission}</span>
                        </div>
                        <button
                          type="button"
                          className="lx-icon-btn danger"
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
          <div className="lx-modal-foot">
            <button type="button" className="lx-btn lx-btn-secondary" onClick={onClose}>
              <IconX size={16} className="me-1" />
              Done
            </button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
