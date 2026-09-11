"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, clearToken, getToken, type TransparencyLog } from "@/lib/api";

export default function SettingsPage() {
  const router = useRouter();
  const [log, setLog] = useState<TransparencyLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);

  const signOut = useCallback(() => {
    clearToken();
    router.replace("/login");
  }, [router]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api
      .transparencyLog()
      .then(setLog)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) signOut();
        else setError(e instanceof ApiError ? e.message : "Could not load transparency log.");
      })
      .finally(() => setLoading(false));
  }, [router, signOut]);

  async function purge() {
    setPurging(true);
    try {
      await api.purgeAccount();
      signOut();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Purge failed. Please try again.");
      setPurging(false);
      setConfirming(false);
    }
  }

  return (
    <div className="page">
      <header className="navbar navbar-expand-md d-print-none">
        <div className="container-xl">
          <h1 className="navbar-brand mb-0">Settings & Privacy</h1>
          <div className="navbar-nav ms-auto flex-row gap-2">
            <Link className="nav-link" href="/">
              Dashboard
            </Link>
            <Link className="nav-link" href="/chat">
              Chat
            </Link>
          </div>
        </div>
      </header>
      <div className="page-body">
        <div className="container-xl" style={{ maxWidth: 720 }}>
          {error && <div className="alert alert-danger">{error}</div>}
          <div className="card mb-3">
            <div className="card-header">
              <h3 className="card-title">Data transparency log</h3>
            </div>
            <div className="card-body">
              {loading ? (
                <div className="text-muted">Loading…</div>
              ) : log ? (
                <>
                  <h4>Stored in PostgreSQL (tenant-isolated, RLS-guarded)</h4>
                  <ul>
                    <li>Account metadata: {log.stored_in_postgres.account_metadata.join(", ")}</li>
                    <li>Documents: {log.stored_in_postgres.documents}</li>
                    <li>Chunks / vectors: {log.stored_in_postgres.chunks_vectors}</li>
                    <li>Audit log rows: {log.stored_in_postgres.audit_logs}</li>
                  </ul>
                  <p className="text-muted">{log.stored_in_postgres.isolation}</p>
                  <h4>Sent to NVIDIA NIM</h4>
                  <p>{log.sent_to_nvidia_nim.what}</p>
                  <p className="text-muted">
                    Retention: {log.sent_to_nvidia_nim.retention} · Models:{" "}
                    {log.sent_to_nvidia_nim.models.join(", ")}
                  </p>
                </>
              ) : null}
            </div>
          </div>
          <div className="card card-borderless bg-red-lt">
            <div className="card-body">
              <h3 className="card-title text-danger">Danger zone</h3>
              {!confirming ? (
                <>
                  <p className="text-muted">
                    Purge deletes your documents, vectors, tasks, shares, notifications, approvals,
                    audit rows, checkpoints, and the account itself.
                  </p>
                  <button className="btn btn-outline-danger" onClick={() => setConfirming(true)}>
                    Delete my account and all data…
                  </button>
                </>
              ) : (
                <>
                  <p>
                    <strong>This cannot be undone.</strong> Confirm permanent deletion of everything?
                  </p>
                  <div className="d-flex gap-2">
                    <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                    <button className="btn btn-danger" onClick={purge} disabled={purging}>
                      {purging ? "Purging…" : "Yes, purge everything"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
