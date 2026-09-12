"use client";

import { IconAlertTriangle, IconCloudUpload, IconFileText } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";

import { ApiError, api, type AsyncUploadResponse, type UploadResponse } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { ProcessingCard } from "@/components/ProcessingCard";
import { openWorkerLiveStream } from "@/lib/sse";

const MAX_BYTES = 25 * 1024 * 1024;

interface DropzoneProps {
  onUploaded: (result: UploadResponse) => void;
  disabled?: boolean;
}

export function Dropzone({ onUploaded, disabled = false }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [tracked, setTracked] = useState<{ id: string; filename: string; status: string; error?: string } | null>(null);

  const finishAsync = useCallback(
    async (queued: AsyncUploadResponse) => {
      // Watch worker progress over SSE; fall back to polling so a dropped
      // stream can never leave the card stuck.
      const done = (finalStatus: string, failure?: string) => {
        setTracked((t) => (t && t.id === queued.document_id ? { ...t, status: finalStatus, error: failure } : t));
      };
      const stream = openWorkerLiveStream({
        onStatus: (e) => {
          if (e.document_id === queued.document_id) done(e.status);
        },
        onFailed: (e) => {
          if (e.document_id === queued.document_id) done("failed", e.error);
        },
        onError: () => {},
      });
      const stopAt = Date.now() + 180_000;
      try {
        for (;;) {
          await new Promise((r) => setTimeout(r, 4000));
          const list = await api.listDocuments();
          const doc = list.documents.find((d) => d.id === queued.document_id);
          if (!doc) continue;
          done(doc.status);
          if (["ready", "needs_review", "failed", "deleted"].includes(doc.status)) {
            onUploaded({ document: doc, message: null, warnings: [] });
            setTracked(null);
            break;
          }
          if (Date.now() > stopAt) {
            done("needs_review", "Still processing — refresh the list in a moment.");
            break;
          }
        }
      } catch {
        // Polling hiccup: leave the card showing last known status.
      } finally {
        stream?.close();
        setBusy(false);
      }
    },
    [onUploaded],
  );

  const uploadSync = useCallback(
    async (file: File) => {
      const result = await api.uploadDocument(file);
      setWarnings(result.warnings ?? []);
      onUploaded(result);
    },
    [onUploaded],
  );

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      setWarnings([]);

      if (!file.name.toLowerCase().endsWith(".pdf")) {
        setError("Only PDF files are supported.");
        return;
      }
      if (file.size === 0) {
        setError("That file is empty.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`That file is ${formatBytes(file.size)}. The limit is 25 MB.`);
        return;
      }

      setBusy(true);
      try {
        // Async first (queued + live progress). Any failure → sync fallback,
        // so uploads never depend on Redis/worker availability.
        try {
          const queued = await api.uploadDocumentAsync(file);
          setTracked({ id: queued.document_id, filename: file.name, status: queued.status });
          await finishAsync(queued);
          return;
        } catch (asyncErr) {
          if (asyncErr instanceof ApiError && [401, 403, 413].includes(asyncErr.status)) throw asyncErr;
          await uploadSync(file);
        }
      } catch (err) {
        setTracked(null);
        setError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
      } finally {
        setBusy(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [finishAsync, uploadSync],
  );

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && !busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled || busy) return;
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        className={`dropzone ${dragging ? "dropzone-active" : ""} ${
          disabled || busy ? "opacity-50" : ""
        }`}
        role="button"
        tabIndex={disabled || busy ? -1 : 0}
        aria-label="Upload a PDF document"
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !disabled && !busy) {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <div style={{ marginBottom: "0.6rem" }}>
          <span className="lx-avatar soft-blue" style={{ width: 44, height: 44 }}>
            {busy ? (
              <span className="lx-spinner sm" role="status" />
            ) : (
              <IconCloudUpload size={20} />
            )}
          </span>
        </div>
        {busy ? (
          <div>
            <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Reading your document…</p>
            <p style={{ color: "var(--ink-2)", marginBottom: "0.6rem" }}>Parsing, indexing and extracting. Up to a minute.</p>
            <div className="progress progress-sm mx-auto" style={{ maxWidth: 220 }}>
              <div className="progress-bar progress-bar-indeterminate" />
            </div>
          </div>
        ) : (
          <div>
            <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>Drag a PDF here, or browse</p>
            <p style={{ color: "var(--ink-2)", marginBottom: "0.9rem" }}>Bills, policies, warranties, rental or vehicle records</p>
            <button
              type="button"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
              className="lx-btn lx-btn-primary lx-btn-sm"
            >
              <IconFileText size={16} className="me-1" />
              Choose PDF file
            </button>
                      </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          disabled={disabled || busy}
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </div>

      {tracked ? (
        <div className="mt-2">
          <ProcessingCard filename={tracked.filename} status={tracked.status} error={tracked.error} />
        </div>
      ) : null}

      {error ? (
        <div className="lx-alert lx-alert-red" role="alert" style={{ marginTop: "0.6rem" }}>
          <IconAlertTriangle size={16} className="me-2" />
          {error}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="lx-alert lx-alert-yellow" role="alert" style={{ marginTop: "0.6rem" }}>
          <div>
            <div style={{ fontWeight: 650, marginBottom: 4 }}>Saved with warnings</div>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
