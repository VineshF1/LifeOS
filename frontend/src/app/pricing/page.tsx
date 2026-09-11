"use client";

import { IconArrowLeft, IconCheck, IconCrown } from "@tabler/icons-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, api, clearToken, getToken } from "@/lib/api";

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
      setNotice(e instanceof ApiError ? e.message : "Checkout failed.");
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
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : "Payment failed.");
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
              setNotice(
                s.subscription_tier === "pro"
                  ? "Payment successful — welcome to Pro."
                  : "Payment received — your Pro activation lands in a moment. Refresh shortly.",
              );
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
    <div className="page">
      <div className="page-wrapper">
        <div className="page-body">
          <div className="container-xl" style={{ maxWidth: 880 }}>
            <Link href="/" className="btn btn-ghost-secondary btn-sm mb-3">
              <IconArrowLeft size={16} className="me-1" />
              Back to dashboard
            </Link>
            <div className="page-pretitle">LifeOS Agent plans</div>
            <h2 className="page-title mb-3">Simple pricing that grows with your paperwork</h2>
            {notice ? (
              <div className="alert alert-info" role="alert">
                {notice}
              </div>
            ) : null}
            <div className="row row-cards">
              <div className="col-md-6">
                <div className="card">
                  <div className="card-body text-center">
                    <h3 className="card-title">Free</h3>
                    <div className="display-6 my-2">₹0</div>
                    <ul className="list-unstyled text-muted">
                      {FREE_FEATURES.map((f) => (
                        <li key={f} className="mb-1">
                          <IconCheck size={14} className="me-1" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <span className={`badge ${tier === "free" ? "bg-blue-lt" : "bg-muted-lt"}`}>
                      {tier === "free" ? "Current plan" : "Free forever"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="col-md-6">
                <div className="card card-stacked">
                  <div className="card-body text-center">
                    <h3 className="card-title">
                      <IconCrown size={16} className="me-1" />
                      Pro · ₹99/mo
                    </h3>
                    <div className="display-6 my-2">₹99</div>
                    <ul className="list-unstyled text-muted">
                      {PRO_FEATURES.map((f) => (
                        <li key={f} className="mb-1">
                          <IconCheck size={14} className="me-1" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    {tier === "pro" ? (
                      <span className="badge bg-green-lt">Current plan</span>
                    ) : showPayment && !razorpayConfigured ? (
                      <div className="card mt-2" style={{ background: "var(--tblr-bg-surface-secondary)" }}>
                        <div className="card-body">
                          <div className="fw-medium mb-1">Demo payment</div>
                          <p className="text-muted mb-2" style={{ fontSize: 13 }}>
                            LifeOS Pro · ₹99/mo · test mode, no real charge.
                          </p>
                          <div className="d-flex gap-2 justify-content-center">
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              disabled={busy}
                              onClick={() => setShowPayment(false)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy}
                              onClick={() => void confirmDemoPayment()}
                            >
                              {busy ? <span className="spinner-border spinner-border-sm me-2" role="status" /> : null}
                              Pay ₹99
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void upgrade()}>
                          {busy ? <span className="spinner-border spinner-border-sm me-2" role="status" /> : null}
                          Upgrade to Pro
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
