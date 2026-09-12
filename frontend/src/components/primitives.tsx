"use client";

import { motion, useInView } from "motion/react";
import { animate } from "motion";
import { useEffect, useRef, type ReactNode } from "react";

export const EASE = [0.23, 1, 0.32, 1] as const;

/** Scroll-triggered reveal (lazy-section language): fade + rise once. */
export function Reveal({
  children,
  delay = 0,
  y = 18,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** Animated counter with tabular figures (Vengeance animated-number language). */
export function AnimatedNumber({
  value,
  duration = 0.9,
  className,
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const inView = useInView(wrapRef, { once: true });

  useEffect(() => {
    if (!inView) return;
    const controls = animate(0, value, {
      duration,
      ease: [0.23, 1, 0.32, 1],
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = Math.round(v).toLocaleString("en-IN");
      },
    });
    return () => controls.stop();
  }, [inView, value, duration]);

  return (
    <span ref={wrapRef} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      <span ref={ref}>0</span>
    </span>
  );
}

/** Beam of light travelling the border (Vengeance border-beam, CSS-only). */
export function BorderBeam({
  size = 180,
  duration = 12,
  colorFrom = "#206bc4",
  colorTo = "#7fb3f0",
  className = "",
}: {
  size?: number;
  duration?: number;
  colorFrom?: string;
  colorTo?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`border-beam ${className}`}
      style={
        {
          "--beam-size": `${size}px`,
          "--beam-duration": `${duration}s`,
          "--beam-from": colorFrom,
          "--beam-to": colorTo,
        } as React.CSSProperties
      }
    />
  );
}

/** Card with a soft top glow for featured surfaces (Pro card, processing). */
export function GlowCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`lx-card glow-card ${className}`} style={{ position: "relative", overflow: "hidden" }}>
      <span aria-hidden className="glow-card-glow" />
      {children}
    </div>
  );
}
