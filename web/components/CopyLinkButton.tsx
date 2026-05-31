"use client";
import { useState } from "react";
import { Copy, Check, X } from "@phosphor-icons/react/dist/ssr";

export default function CopyLinkButton({ path }: { path: string }) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");

  async function onClick() {
    const url =
      typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setState("ok");
    } catch {
      setState("err");
    }
    setTimeout(() => setState("idle"), 1800);
  }

  const label =
    state === "ok" ? "Copied" : state === "err" ? "Copy failed" : "Copy link";
  const Icon = state === "ok" ? Check : state === "err" ? X : Copy;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Copy shareable link"
      className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--amber)]"
    >
      <Icon size={12} weight="bold" />
      {label}
    </button>
  );
}
