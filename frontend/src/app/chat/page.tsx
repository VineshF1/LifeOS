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
    <div className="page">
      <header className="navbar navbar-expand-md d-print-none">
        <div className="container-xl">
          <h1 className="navbar-brand mb-0">LifeOS Chat</h1>
          <div className="navbar-nav ms-auto flex-row gap-2">
            <Link className="nav-link" href="/">
              Dashboard
            </Link>
            <Link className="nav-link" href="/settings">
              Settings
            </Link>
          </div>
        </div>
      </header>
      <div className="page-body">
        <div className="container-xl" style={{ height: "75vh" }}>
          {toast && (
            <div className="alert alert-warning py-2" role="alert">
              {toast}
            </div>
          )}
          <div className="card h-100">
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
      </div>
    </div>
  );
}
