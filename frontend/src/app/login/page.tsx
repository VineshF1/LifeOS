"use client";

import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState } from "react";

import { ApiError, api, setToken } from "@/lib/api";

const EASE = [0.23, 1, 0.32, 1] as const;

const TRUST = [
  { title: "Private by architecture", body: "Your files live in an isolated vault — no user ever touches another's data." },
  { title: "Every answer shows its proof", body: "Each reply cites the exact page it came from. No blind trust required." },
  { title: "Delete really deletes", body: "Files, vectors, history — wiped on request, logged for proof." },
];

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <span style={{ display: "block", overflow: "hidden" }}>
      <motion.span
        style={{ display: "block" }}
        initial={{ y: "110%" }}
        animate={{ y: "0%" }}
        transition={{ duration: 0.7, ease: EASE, delay }}
      >
        {children}
      </motion.span>
    </span>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      const response =
        mode === "signup"
          ? await api.signup(email.trim(), password)
          : await api.login(email.trim(), password);
      setToken(response.access_token);
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100dvh", display: "flex" }}>
      {/* Brand panel */}
      <div
        className="lx-login-brand"
        style={{
          width: "46%",
          background: "#101828",
          color: "#fff",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "2.5rem",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(60% 45% at 20% 10%, rgba(32,107,196,0.28), transparent 70%), radial-gradient(50% 40% at 85% 90%, rgba(32,107,196,0.16), transparent 70%)",
          }}
        />
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "0.55rem", fontWeight: 700, fontSize: "1.12rem" }}>
          <img src="/logo.png" alt="Prova logo" className="logo-img logo-on-dark" style={{ width: 30, height: 30 }} />
          Prova
        </div>

        <div style={{ position: "relative", maxWidth: 480 }}>
          <h1 style={{ fontSize: "clamp(2rem, 4vw, 3rem)", fontWeight: 750, lineHeight: 1.05, marginBottom: "1rem" }}>
            <Reveal>Ask your paperwork</Reveal>
            <Reveal delay={0.08}>anything.</Reveal>
          </h1>
          <motion.p
            style={{ color: "rgba(255,255,255,0.72)", fontSize: 17, marginBottom: "1.5rem" }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.2 }}
          >
            Upload bills, policies, and warranties. Prova reads them all, then
            answers with the exact page as proof — expiry dates, hidden
            charges, fine print. Just ask.
          </motion.p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
            {TRUST.map((t, i) => (
              <motion.div
                key={t.title}
                style={{ display: "flex", gap: "0.7rem", alignItems: "flex-start" }}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: EASE, delay: 0.3 + i * 0.1 }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    marginTop: 7,
                    flex: "none",
                  }}
                />
                <span>
                  <span style={{ display: "block", fontWeight: 600 }}>{t.title}</span>
                  <span style={{ display: "block", color: "rgba(255,255,255,0.62)", fontSize: 14 }}>
                    {t.body}
                  </span>
                </span>
              </motion.div>
            ))}
          </div>
        </div>

        <div style={{ position: "relative", color: "rgba(255,255,255,0.45)", fontSize: 13 }}>
          Privacy-first personal document intelligence
        </div>
      </div>

      {/* Form side */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "1.5rem" }}>
        <motion.div
          style={{ width: "100%", maxWidth: 400 }}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
        >
          <div className="lx-login-mark">
            <img src="/logo.png" alt="Prova logo" className="logo-img logo-on-dark" style={{ width: 40, height: 40 }} />
            <h1 style={{ fontSize: "1.6rem", fontWeight: 700 }}>Prova</h1>
          </div>

          <h2 style={{ fontSize: "1.4rem", fontWeight: 700, marginBottom: "0.25rem" }}>
            {mode === "login" ? "Welcome back" : "Create your vault"}
          </h2>
          <p className="lx-sub" style={{ marginBottom: "1.5rem" }}>
            {mode === "login" ? "Sign in to your private workspace." : "One account. Your documents stay yours."}
          </p>

          <div className="lx-card">
            <div className="lx-card-body">
              <div
                role="group"
                aria-label="Sign in or create account"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 4,
                  padding: 4,
                  borderRadius: 12,
                  background: "var(--surface-2)",
                  marginBottom: "1rem",
                }}
              >
                {(["login", "signup"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setMode(option);
                      setError(null);
                    }}
                    className={`lx-btn lx-btn-sm ${mode === option ? "lx-btn-primary" : "lx-btn-ghost"}`}
                    style={{ border: 0 }}
                  >
                    {option === "login" ? "Sign in" : "Create account"}
                  </button>
                ))}
              </div>

              <form onSubmit={submit}>
                <div style={{ marginBottom: "0.9rem" }}>
                  <label className="lx-label" htmlFor="email">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="lx-input"
                  />
                </div>
                <div style={{ marginBottom: "0.9rem" }}>
                  <label className="lx-label" htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
                    className="lx-input"
                  />
                </div>

                {error ? (
                  <div className="lx-alert lx-alert-red" role="alert" style={{ marginBottom: "0.9rem" }}>
                    {error}
                  </div>
                ) : null}

                <button type="submit" disabled={busy} className="lx-btn lx-btn-primary lx-btn-block">
                  {busy ? "Signing in…" : mode === "login" ? "Sign in" : "Create account"}
                </button>
              </form>
            </div>
          </div>
        </motion.div>
      </div>

      <style>{`
        @media (max-width: 1023px) {
          .lx-login-brand { display: none !important; }
        }
        .lx-login-mark { display: none; text-align: center; margin-bottom: 1.25rem; }
        .lx-login-mark .lx-avatar { margin: 0 auto 0.5rem; }
        @media (max-width: 1023px) {
          .lx-login-mark { display: block; }
        }
      `}</style>
    </div>
  );
}
