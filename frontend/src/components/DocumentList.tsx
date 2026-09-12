"use client";

import { IconCalendarDue, IconFileText, IconShare, IconTrash } from "@tabler/icons-react";
import { motion } from "motion/react";
import { CATEGORIES, type DocumentOut } from "@/lib/api";
import { formatDate } from "@/lib/utils";

interface DocumentListProps {
  documents: DocumentOut[];
  loading: boolean;
  category: string;
  onCategoryChange: (category: string) => void;
  onSelect: (document: DocumentOut) => void;
  onDelete: (document: DocumentOut) => void;
  onShare?: (document: DocumentOut) => void;
  activeDocumentId: string | null;
}

function statusClass(status: string): string {
  if (status === "ready") return "lx-badge-green";
  if (status === "needs_review") return "lx-badge-yellow";
  return "lx-badge-blue";
}

function statusDot(status: string): string {
  if (status === "ready") return "var(--green)";
  if (status === "needs_review") return "var(--yellow)";
  if (status === "failed" || status === "deleted") return "var(--red)";
  return "var(--accent)";
}

export function DocumentList({
  documents,
  loading,
  category,
  onCategoryChange,
  onSelect,
  onDelete,
  onShare,
  activeDocumentId,
}: DocumentListProps) {
  const filters = ["All", ...CATEGORIES];

  return (
    <div>
      <div className="lx-pills" role="group" aria-label="Filter by category" style={{ marginBottom: "0.8rem" }}>
        {filters.map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => onCategoryChange(filter)}
            className={`lx-pill ${category === filter ? "on" : ""}`}
            aria-pressed={category === filter}
          >
            {filter}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label="Loading documents">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="skel" style={{ width: 34, height: 34, borderRadius: 10 }} />
              <span style={{ flex: 1 }}>
                <span className="skel" style={{ width: "70%", marginBottom: 6 }} />
                <span className="skel" style={{ width: "45%", minHeight: "0.7em" }} />
              </span>
            </div>
          ))}
        </div>
      ) : documents.length === 0 ? (
        <div className="lx-empty">
          <div>
            <span className="lx-avatar soft-blue" style={{ width: 44, height: 44 }}>
              <IconFileText size={22} />
            </span>
          </div>
          <p className="lx-empty-title">No documents yet</p>
          <p className="lx-empty-sub">Upload your first PDF above — bills, policies, warranties.</p>
        </div>
      ) : (
        <div>
          {documents.map((document, index) => {
            const deadline = document.metadata?.action_deadline ?? null;
            const amount = document.metadata?.financial_amount ?? null;
            const currency = document.metadata?.currency ?? "";
            const isActive = activeDocumentId === document.id;

            return (
              <motion.div
                key={document.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: 0.4,
                  ease: [0.23, 1, 0.32, 1],
                  delay: Math.min(index, 6) * 0.04,
                }}
                className={`lx-row doc-row ${isActive ? "doc-row-active" : ""}`}
                style={{ cursor: "pointer" }}
                onClick={() => onSelect(document)}
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(document);
                  }
                }}
              >
                <span
                  aria-hidden
                  title={`Status: ${document.status.replace("_", " ")}`}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    marginTop: 7,
                    flex: "none",
                    background: statusDot(document.status),
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {document.filename}
                  </span>
                  <span className="tnum" style={{ display: "block", color: "var(--ink-2)", fontSize: 12 }}>
                    {document.chunk_count} chunks · {formatDate(document.created_at)} ·{" "}
                    {document.category}
                    {amount !== null ? ` · ${currency} ${amount}` : ""}
                  </span>
                  {deadline ? (
                    <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--ink-2)", fontSize: 12 }}>
                      <IconCalendarDue size={13} />
                      Due {formatDate(deadline)}
                    </span>
                  ) : null}
                  <span className={`lx-badge mt-1 ${statusClass(document.status)}`} style={{ marginTop: 6 }}>
                    {document.status.replace("_", " ")}
                  </span>
                </div>
                <span className="doc-actions" style={{ display: "flex", gap: 2, flex: "none" }}>
                  {onShare ? (
                    <button
                      type="button"
                      title={`Share ${document.filename}`}
                      aria-label={`Share ${document.filename}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onShare(document);
                      }}
                      className="lx-icon-btn"
                    >
                      <IconShare size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title={`Delete ${document.filename}`}
                    aria-label={`Delete ${document.filename}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(document);
                    }}
                    className="lx-icon-btn danger"
                  >
                    <IconTrash size={16} />
                  </button>
                </span>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
