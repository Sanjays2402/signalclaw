"use client";
import { useState } from "react";
import { PushPin, PushPinSlash } from "@phosphor-icons/react/dist/ssr";

export default function PinToggle({
  runId,
  initialPinned,
}: {
  runId: string;
  initialPinned: boolean;
}) {
  const [pinned, setPinned] = useState(initialPinned);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setErr(null);
    const next = !pinned;
    try {
      const r = await fetch(`/api/runs/${runId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`${r.status}${text ? `: ${text}` : ""}`);
      }
      setPinned(next);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch">
      <button
        onClick={toggle}
        disabled={busy}
        aria-pressed={pinned}
        aria-label={pinned ? "Unpin run" : "Pin run"}
        title={pinned ? "Unpin from your home rail" : "Pin to your home rail"}
        className={
          "text-[11px] px-3 py-2 rounded-sm border uppercase tracking-widest font-semibold mono flex items-center gap-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--amber)] disabled:opacity-50 " +
          (pinned
            ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
            : "border-[var(--border-strong)] hover:bg-white/5")
        }
      >
        {pinned ? (
          <PushPinSlash size={12} weight="bold" />
        ) : (
          <PushPin size={12} weight="bold" />
        )}
        {pinned ? "Pinned" : "Pin"}
      </button>
      {err && (
        <span className="text-[10px] mono mt-1" style={{ color: "var(--red)" }}>
          {err}
        </span>
      )}
    </div>
  );
}
