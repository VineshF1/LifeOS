"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api, clearToken, getToken } from "@/lib/api";
import { GlowCard, Reveal } from "@/components/primitives";

const FREE_FEATURES = ["5 document uploads", "Single-document Q&A", "Basic task creation"];
const PRO_FEATURES = [
  "Unlimited documents",
  "Cross-document synthesis",
  "Human-in-the-loop automation",
  "Calendar (.ics) exports",
  "Document sharing with ACL",
];

export default function PricingPage() {
  const router = useRouter();
  const [tier, setTier] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [razorpayConfigured, setRazorpayConfigured] = useState(false);
  const [showPayment, setShowPayment] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api
      .billingStatus()
      .then((s) => {
        setTier(s.subscription_tier);
        setRazorpayConfigured(s.razorpay_configured);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          router.replace("/login");
        }
      });
  }, [router]);

  async function upgrade() {
    setBusy(true);
    setNotice(null);
    try {
      // Re-read status on every click: the backend env may have gained keys
      // after this page loaded, and mount-time state would be stale.
      const status = await api.billingStatus();
      setTier(status.subscription_tier);
      setRazorpayConfigured(status.razorpay_configured);
      if (status.subscription_tier === "pro") {
        setNotice("You're already on Pro — enjoy unlimited uploads and synthesis.");
        return;
      }
      // Live Razorpay path: create a subscription and open Checkout (the payment page).
      if (status.razorpay_configured) {
        const result = await api.createCheckoutSession();
        if (result.subscription_id && result.razorpay_key_id) {
          openRazorpayCheckout(result.razorpay_key_id, result.subscription_id);
          return;
        }
        setNotice(result.message);
        return;
      }
      // Demo mode (no Razorpay keys): show the in-app payment step first so the
      // upgrade never flips silently — the user confirms on a payment screen.
      setShowPayment(true);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Checkout failed.";
      setNotice(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDemoPayment() {
    setBusy(true);
    setNotice(null);
    try {
      // Demo mode: the backend flips the tier here, after the user paid on the
      // payment step above — not on the first Upgrade click.
      const result = await api.createCheckoutSession();
      if (result.subscription_id && result.razorpay_key_id) {
        // Gateway became configured after this page loaded — open live checkout.
        setShowPayment(false);
        openRazorpayCheckout(result.razorpay_key_id, result.subscription_id);
        return;
      }
      setTier(result.subscription_tier);
      setShowPayment(false);
      setNotice(result.message);
      toast.success("Welcome to Pro.");
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Payment failed.";
      setNotice(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function openRazorpayCheckout(keyId: string, subscriptionId: string) {
    const scriptSrc = "https://checkout.razorpay.com/v1/checkout.js";
    const launch = () => {
      const Razorpay = (window as unknown as Record<string, unknown>).Razorpay as new (
        options: Record<string, unknown>,
      ) => { open: () => void };
      const rzp = new Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: "LifeOS Agent",
        description: "Pro subscription · ₹99/mo",
        handler: () => {
          // Webhook activates Pro; refresh status in case it already landed.
          api
            .billingStatus()
            .then((s) => {
              setTier(s.subscription_tier);
              const msg =
                s.subscription_tier === "pro"
                  ? "Payment successful — welcome to Pro."
                  : "Payment received — your Pro activation lands in a moment. Refresh shortly.";
              setNotice(msg);
              toast.success(msg);
            })
            .catch(() => setNotice("Payment received — refresh shortly to see Pro."));
        },
        modal: { ondismiss: () => setBusy(false) },
        theme: { color: "#206bc4" },
      });
      rzp.open();
    };
    if (document.querySelector(`script[src="${scriptSrc}"]`)) {
      launch();
      return;
    }
    const script = document.createElement("script");
    script.src = scriptSrc;
    script.async = true;
    script.onload = launch;
    script.onerror = () => {
      setNotice("Could not load Razorpay Checkout. Check your connection and retry.");
      setBusy(false);
    };
    document.body.appendChild(script);
  }

  return (
    <div className="lx-page">
      <main className="lx-main">
        <div className="lx-container" style={{ maxWidth: 880 }}>
          <Link href="/" className="lx-btn lx-btn-ghost lx-btn-sm" style={{ textDecoration: "none", marginBottom: "1rem" }}>
            ← Back to dashboard
          </Link>
          <Reveal>
            <div className="lx-eyebrow">LifeOS Agent plans</div>
            <h2 className="lx-title" style={{ marginBottom: "0.3rem" }}>Simple pricing that grows with your paperwork</h2>
            <p className="lx-sub" style={{ marginBottom: "1.5rem" }}>Start free. Upgrade when your vault outgrows it.</p>
          </Reveal>
          {notice ? (
            <div className="lx-alert lx-alert-blue" role="alert" style={{ marginBottom: "1rem" }}>
              {notice}
            </div>
          ) : null}
          <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <Reveal delay={0.05}>
              <div className="lx-card" style={{ height: "100%" }}>
                <div className="lx-card-body" style={{ textAlign: "center", display: "flex", flexDirection: "column", height: "100%" }}>
                  <h3 style={{ fontSize: "1.05rem" }}>Free</h3>
                  <div className="tnum" style={{ fontSize: "2.2rem", fontWeight: 750, margin: "0.5rem 0" }}>₹0</div>
                  <ul style={{ listStyle: "none", padding: 0, margin: "0 auto", maxWidth: 260, textAlign: "left", color: "var(--ink-2)" }}>
                    {FREE_FEATURES.map((f) => (
                      <li key={f} style={{ marginBottom: "0.55rem", display: "flex", gap: 8 }}>
                        <span aria-hidden style={{ color: "var(--green)", fontWeight: 700 }}>✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <div style={{ marginTop: "auto", paddingTop: "1rem" }}>
                    {tier === "free" ? (
                      <span className="lx-badge lx-badge-blue">Current plan</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </Reveal>
            <Reveal delay={0.12}>
              <GlowCard className="h-100">
                <div className="lx-card-body" style={{ textAlign: "center", display: "flex", flexDirection: "column", height: "100%" }}>
                  <h3 style={{ fontSize: "1.05rem" }}>★ Pro · ₹99/mo</h3>
                  <div className="tnum" style={{ fontSize: "2.2rem", fontWeight: 750, margin: "0.5rem 0" }}>₹99</div>
                  <ul style={{ listStyle: "none", padding: 0, margin: "0 auto", maxWidth: 260, textAlign: "left", color: "var(--ink-2)" }}>
                    {PRO_FEATURES.map((f) => (
                      <li key={f} style={{ marginBottom: "0.55rem", display: "flex", gap: 8 }}>
                        <span aria-hidden style={{ color: "var(--green)", fontWeight: 700 }}>✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                  <div style={{ marginTop: "auto", paddingTop: "1rem" }}>
                    {tier === "pro" ? (
                      <span className="lx-badge lx-badge-green">Current plan</span>
                    ) : showPayment && !razorpayConfigured ? (
                      <div className="lx-card" style={{ background: "var(--surface-2)", marginTop: "0.5rem" }}>
                        <div className="lx-card-body">
                          <div style={{ fontWeight: 650, marginBottom: "0.25rem" }}>Demo payment</div>
                          <p className="lx-hint" style={{ marginBottom: "0.6rem" }}>
                            LifeOS Pro · ₹99/mo · test mode, no real charge.
                          </p>
                          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                            <button
                              type="button"
                              className="lx-btn lx-btn-secondary"
                              disabled={busy}
                              onClick={() => setShowPayment(false)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="lx-btn lx-btn-primary"
                              disabled={busy}
                              onClick={() => void confirmDemoPayment()}
                            >
                              {busy ? "Processing…" : "Pay ₹99"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="lx-btn lx-btn-primary" disabled={busy} onClick={() => void upgrade()}>
                        {busy ? "Working…" : "Upgrade to Pro"}
                      </button>
                    )}
                  </div>
                </div>
              </GlowCard>
            </Reveal>
          </div>
        </div>
      </main>
    </div>
  );
}
