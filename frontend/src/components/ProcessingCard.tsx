"use client";

import { motion } from "motion/react";
import { BorderBeam } from "@/components/primitives";

const STAGES = ["queued", "parsing", "extracting", "embedding", "ready"] as const;

const TERMINAL_BAD = new Set(["failed", "needs_review", "deleted"]);

const STAGE_LABEL: Record<string, string> = {
  queued: "In queue",
  parsing: "Reading pages",
  extracting: "Understanding fields",
  embedding: "Indexing for search",
  ready: "Ready",
};

export function ProcessingCard({
  filename,
  status,
  error,
}: {
  filename: string;
  status: string;
  error?: string | null;
}) {
  const normalized = status.toLowerCase();
  const failed = TERMINAL_BAD.has(normalized);
  const activeIndex = failed
    ? -1
    : Math.max(
        0,
        STAGES.indexOf(normalized as (typeof STAGES)[number]),
      );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
      className="lx-card"
      style={{ position: "relative", overflow: "hidden", marginBottom: "0.6rem" }}
    >
      {!failed && normalized !== "ready" ? <BorderBeam size={140} duration={8} /> : null}
      <div style={{ padding: "0.85rem 1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: "0.6rem" }}>
          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "62%" }} title={filename}>
            {filename}
          </strong>
          <span
            className={`lx-badge ${failed ? "lx-badge-red" : normalized === "ready" ? "lx-badge-green" : "lx-badge-blue"}`}
          >
            {failed ? status.replace("_", " ") : (STAGE_LABEL[normalized] ?? status)}
          </span>
        </div>
        {!failed ? (
          <div style={{ display: "flex", alignItems: "center", gap: 4 }} aria-label={`Processing stage: ${status}`}>
            {STAGES.map((stage, i) => (
              <div key={stage} style={{ flex: 1 }} title={STAGE_LABEL[stage]}>
                <motion.div
                  style={{ height: 6, borderRadius: 3 }}
                  className={i <= activeIndex ? "bg-blue" : "bg-muted"}
                  initial={false}
                  animate={{ opacity: i <= activeIndex ? 1 : 0.45 }}
                />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: "var(--red)", fontSize: 13 }}>
            {error ?? "Processing failed. Check the runbook or re-upload."}
          </div>
        )}
      </div>
    </motion.div>
  );
}
