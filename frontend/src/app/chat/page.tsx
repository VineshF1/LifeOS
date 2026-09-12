"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChatPane } from "@/components/ChatPane";
import { ApiError, api, clearToken, getToken, type DocumentOut } from "@/lib/api";

export default function ChatPage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [scopeDocumentId, setScopeDocumentId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
      .listDocuments()
      .then((r) => setDocuments(r.documents))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) signOut();
      });
  }, [router, signOut]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <div className="lx-page">
      <header className="lx-header">
        <div className="lx-container lx-header-inner">
          <h1 style={{ fontSize: "1.02rem", fontWeight: 700 }}>LifeOS Chat</h1>
          <span style={{ flex: 1 }} />
          <Link className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }} href="/">
            Dashboard
          </Link>
          <Link className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none" }} href="/settings">
            Settings
          </Link>
        </div>
      </header>
      <main className="lx-main">
        <div className="lx-container" style={{ height: "75vh" }}>
          {toast && (
            <div className="lx-alert lx-alert-yellow" role="alert">
              {toast}
            </div>
          )}
          <div className="lx-card" style={{ height: "100%" }}>
            <ChatPane
              documents={documents}
              scopeDocumentId={scopeDocumentId}
              onScopeChange={setScopeDocumentId}
              onSessionExpired={signOut}
              onTasksChanged={() => {}}
              onRateLimited={() =>
                setToast("Chat rate limit hit (20/min). Slow down — your conversation is safe.")
              }
            />
          </div>
        </div>
      </main>
    </div>
  );
}
