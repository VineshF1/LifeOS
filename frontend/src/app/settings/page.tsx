"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, clearToken, getToken, type TransparencyLog } from "@/lib/api";
import { Reveal } from "@/components/primitives";
import { ThemeToggle } from "@/components/theme";

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
      toast.success("Everything deleted. Signing out.");
      signOut();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Purge failed. Please try again.";
      setError(message);
      toast.error(message);
      setPurging(false);
      setConfirming(false);
    }
  }

  return (
    <div className="lx-page">
      <header className="lx-header">
        <div className="lx-container lx-header-inner">
          <h1 style={{ fontSize: "1.02rem", fontWeight: 700 }}>Settings & privacy</h1>
          <span style={{ flex: 1 }} />
          <ThemeToggle />
          <Link className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }} href="/">
            Dashboard
          </Link>
          <Link className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }} href="/chat">
            Chat
          </Link>
        </div>
      </header>
      <main className="lx-main">
        <div className="lx-container" style={{ maxWidth: 720 }}>
          {error && <div className="lx-alert lx-alert-red" style={{ marginBottom: "1rem" }}>{error}</div>}
          <Reveal>
            <div className="lx-card" style={{ marginBottom: "1rem" }}>
              <div className="lx-card-head">
                <h3>Data transparency log</h3>
                <span className="spacer lx-hint">
                  Live from your account
                </span>
              </div>
              <div className="lx-card-body">
                {loading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label="Loading transparency log">
                    <span className="skel" style={{ width: "70%" }} />
                    <span className="skel" style={{ width: "90%", minHeight: "0.8em" }} />
                    <span className="skel" style={{ width: "60%", minHeight: "0.8em" }} />
                  </div>
                ) : log ? (
                  <>
                    <h4 style={{ marginBottom: "0.6rem" }}>Kept in your database</h4>
                    <div style={{ display: "flex", gap: "1.4rem", marginBottom: "0.9rem" }}>
                      {[
                        { v: log.stored_in_postgres.documents, l: "documents" },
                        { v: log.stored_in_postgres.chunks_vectors, l: "vectors" },
                        { v: log.stored_in_postgres.audit_logs, l: "audit rows" },
                      ].map((s) => (
                        <div key={s.l}>
                          <div className="tnum" style={{ fontSize: "1.5rem", fontWeight: 700 }}>{s.v}</div>
                          <div className="lx-hint">{s.l}</div>
                        </div>
                      ))}
                    </div>
                    <p className="lx-hint" style={{ fontSize: 13 }}>
                      Account fields: {log.stored_in_postgres.account_metadata.join(", ")}.
                      {" "}{log.stored_in_postgres.isolation}
                    </p>
                    <hr />
                    <h4 style={{ marginBottom: "0.6rem" }}>Sent to AI, never stored there</h4>
                    <p style={{ marginBottom: "0.3rem" }}>{log.sent_to_nvidia_nim.what}</p>
                    <p className="lx-hint" style={{ fontSize: 13 }}>
                      Retention: {log.sent_to_nvidia_nim.retention} · Models:{" "}
                      {log.sent_to_nvidia_nim.models.join(", ")}
                    </p>
                  </>
                ) : null}
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="lx-card" style={{ borderColor: "rgba(224,49,49,0.3)", background: "var(--red-soft)" }}>
              <div className="lx-card-body">
                <h3 style={{ color: "var(--red)" }}>Danger zone</h3>
                {!confirming ? (
                  <>
                    <p style={{ color: "var(--ink-2)" }}>
                      Purge deletes your documents, vectors, tasks, shares, notifications,
                      approvals, audit rows, checkpoints, and the account itself.
                    </p>
                    <button className="lx-btn lx-btn-outline-danger" onClick={() => setConfirming(true)}>
                      Delete my account and all data…
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>This cannot be undone.</strong> Confirm permanent deletion of everything?
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="lx-btn lx-btn-secondary" onClick={() => setConfirming(false)}>
                        Cancel
                      </button>
                      <button className="lx-btn lx-btn-danger" onClick={purge} disabled={purging}>
                        {purging ? "Purging…" : "Yes, purge everything"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </Reveal>
        </div>
      </main>
    </div>
  );
}
