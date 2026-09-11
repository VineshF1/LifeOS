"use client";

const STAGES = ["queued", "parsing", "extracting", "embedding", "ready"] as const;

const TERMINAL_BAD = new Set(["failed", "needs_review", "deleted"]);

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
  const activeIndex = failed ? -1 : STAGES.indexOf(normalized as (typeof STAGES)[number]);

  return (
    <div className="card mb-2">
      <div className="card-body p-3">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <strong className="text-truncate" style={{ maxWidth: "60%" }}>
            {filename}
          </strong>
          <span className={`badge ${failed ? "bg-red-lt" : normalized === "ready" ? "bg-green-lt" : "bg-blue-lt"}`}>
            {status}
          </span>
        </div>
        {!failed ? (
          <div className="d-flex gap-1" aria-label={`Processing stage: ${status}`}>
            {STAGES.map((stage, i) => (
              <div
                key={stage}
                title={stage}
                style={{ height: 6, flex: 1, borderRadius: 3 }}
                className={i <= activeIndex ? "bg-blue" : "bg-muted"}
              />
            ))}
          </div>
        ) : (
          <div className="text-danger" style={{ fontSize: 13 }}>
            {error ?? "Processing failed. Check the runbook or re-upload."}
          </div>
        )}
      </div>
    </div>
  );
}
