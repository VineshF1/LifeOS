"use client";

import { motion } from "motion/react";
import { useEffect } from "react";

export function DocumentViewer({
  filename,
  url,
  onDownload,
  onClose,
}: {
  filename: string;
  url: string;
  onDownload: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="lx-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`View ${filename}`}
      onClick={onClose}
    >
      <div className="lx-modal lg" role="document" onClick={(e) => e.stopPropagation()}>
        <motion.div
          className="modal-content"
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
        >
          <div className="lx-modal-head">
            <h5
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {filename}
            </h5>
            <button type="button" className="lx-btn lx-btn-ghost" onClick={onDownload}>
              Download
            </button>
            <button type="button" className="lx-btn lx-btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
          <div style={{ height: "min(72vh, 640px)", background: "var(--ink-3)" }}>
            <iframe
              title={filename}
              src={url}
              style={{ width: "100%", height: "100%", border: 0, display: "block" }}
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
