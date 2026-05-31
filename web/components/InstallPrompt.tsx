"use client";
import { useEffect, useState } from "react";
import { DownloadSimple, X } from "@phosphor-icons/react/dist/ssr";

type BIPEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "sc_pwa_dismissed_at";
const DISMISS_DAYS = 14;

/**
 * Registers the offline-shell service worker and surfaces a small
 * "Install SignalClaw" pill when the browser fires beforeinstallprompt.
 * Dismissal is sticky for 14 days. Hidden on iOS Safari and when already
 * running standalone (display-mode: standalone).
 */
export default function InstallPrompt() {
  const [ev, setEv] = useState<BIPEvent | null>(null);
  const [busy, setBusy] = useState(false);

  // Register SW (production only — avoids HMR conflicts in dev).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal: site still works without offline shell.
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (
      dismissedAt &&
      Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000
    ) {
      return;
    }
    if (
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches
    ) {
      return;
    }
    const onBip = (e: Event) => {
      e.preventDefault();
      setEv(e as BIPEvent);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!ev) return null;

  async function install() {
    if (!ev) return;
    setBusy(true);
    try {
      await ev.prompt();
      const choice = await ev.userChoice;
      if (choice.outcome === "dismissed") {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      }
      setEv(null);
    } finally {
      setBusy(false);
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setEv(null);
  }

  return (
    <div
      className="fixed bottom-3 right-3 z-50 panel flex items-center gap-2 px-3 py-2 text-[11px] shadow-lg"
      role="dialog"
      aria-label="Install SignalClaw"
    >
      <DownloadSimple
        size={16}
        weight="duotone"
        style={{ color: "var(--amber)" }}
      />
      <span className="mono">Install SignalClaw</span>
      <button
        onClick={install}
        disabled={busy}
        className="ml-2 bg-[var(--amber)] text-black font-semibold rounded-sm px-2.5 py-1 uppercase tracking-widest disabled:opacity-50"
      >
        {busy ? "..." : "Install"}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="muted hover:text-white p-1"
      >
        <X size={14} />
      </button>
    </div>
  );
}
