"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkle, ArrowRight, X } from "@phosphor-icons/react/dist/ssr";

const DONE_KEY = "sc_onboarded_v1";
const DISMISS_KEY = "sc_onboard_banner_dismissed_v1";

export default function OnboardingBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const done = localStorage.getItem(DONE_KEY) === "1";
      const dismissed = localStorage.getItem(DISMISS_KEY) === "1";
      if (!done && !dismissed) setVisible(true);
    } catch {
      /* ignore */
    }
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  return (
    <div
      role="region"
      aria-label="Onboarding"
      className="panel p-3 flex items-center gap-3 border-[var(--amber)]/40"
    >
      <Sparkle weight="duotone" size={18} style={{ color: "var(--amber)" }} />
      <div className="text-[12px] flex-1">
        <div className="font-semibold mb-0.5">First time here?</div>
        <div className="muted">
          Run a real regime classification in 90 seconds with a guided walkthrough.
        </div>
      </div>
      <Link
        href="/welcome"
        className="text-[11px] mono uppercase tracking-widest bg-[var(--amber)] text-black font-semibold rounded-sm px-2.5 py-1 hover:opacity-90"
      >
        Start <ArrowRight weight="duotone" size={12} className="inline" />
      </Link>
      <button
        aria-label="Dismiss onboarding banner"
        onClick={dismiss}
        className="muted hover:text-white"
      >
        <X weight="duotone" size={16} />
      </button>
    </div>
  );
}
