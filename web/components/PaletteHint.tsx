"use client";
import { useEffect, useState } from "react";
import { Command } from "@phosphor-icons/react/dist/ssr";

export default function PaletteHint() {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
      }}
      className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--border)] rounded text-[10px] muted hover:bg-white/5"
      aria-label="Open command palette"
    >
      <Command weight="duotone" size={12} />
      {mac ? "⌘K" : "Ctrl K"}
    </button>
  );
}
