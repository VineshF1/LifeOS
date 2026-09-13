"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Toaster } from "sonner";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="data-theme" defaultTheme="light" enableSystem={false}>
      {children}
      <ThemedToaster />
    </ThemeProvider>
  );
}

function ThemedToaster() {
  const { theme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      gap={8}
      closeButton
      richColors={false}
      theme={theme === "dark" ? "dark" : "light"}
    />
  );
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && theme === "dark";

  /** Theme switch as a real-DOM veil: a disc in the outgoing theme color
      collapses into the toggle button, revealing the new theme beneath.
      Transform-only (compositor-driven, no layout/paint per frame), so it
      runs identically in every browser with no snapshot or timing APIs.
      Instant switch when reduced motion is preferred. */
  function switchTheme(event: MouseEvent<HTMLButtonElement>) {
    const next = dark ? "light" : "dark";
    const reduceMotion =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setTheme(next);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const paper =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--paper")
        .trim() || "#ffffff";
    const cover =
      Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      ) + 48;
    const veil = document.createElement("div");
    veil.setAttribute("aria-hidden", "true");
    veil.style.position = "fixed";
    veil.style.left = `${x - cover}px`;
    veil.style.top = `${y - cover}px`;
    veil.style.width = `${cover * 2}px`;
    veil.style.height = `${cover * 2}px`;
    veil.style.borderRadius = "50%";
    veil.style.background = paper;
    veil.style.pointerEvents = "none";
    veil.style.zIndex = "200";
    document.body.appendChild(veil);
    // Press confirmation on the button itself.
    event.currentTarget.animate(
      [{ transform: "scale(1)" }, { transform: "scale(0.8)" }, { transform: "scale(1)" }],
      { duration: 380, easing: "ease-out" },
    );
    // Flip the theme underneath, then collapse the old color into the toggle.
    setTheme(next);
    const collapse = veil.animate(
      [{ transform: "scale(1)", opacity: "1" }, { transform: "scale(0)", opacity: "1" }],
      { duration: 650, easing: "cubic-bezier(0.65, 0, 0.35, 1)" },
    );
    collapse.onfinish = () => veil.remove();
  }

  return (
    <button
      type="button"
      className="lx-icon-btn"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={switchTheme}
    >
      {dark ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
