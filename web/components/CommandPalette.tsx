"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, ArrowRight } from "@phosphor-icons/react/dist/ssr";

type CmdItem = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: (router: ReturnType<typeof useRouter>) => void;
};

const NAV: CmdItem[] = [
  { id: "nav-today", label: "Today", hint: "Daily picks", group: "Navigate", run: (r) => r.push("/") },
  { id: "nav-portfolio", label: "Portfolio", group: "Navigate", run: (r) => r.push("/portfolio") },
  { id: "nav-watchlist", label: "Watchlist", group: "Navigate", run: (r) => r.push("/watchlist") },
  { id: "nav-alerts", label: "Alerts", group: "Navigate", run: (r) => r.push("/alerts") },
  { id: "nav-watches", label: "Watches", hint: "Scheduled regime runs", group: "Navigate", run: (r) => r.push("/watches") },
  { id: "nav-brackets", label: "Brackets", group: "Navigate", run: (r) => r.push("/brackets") },
  { id: "nav-journal", label: "Journal", group: "Navigate", run: (r) => r.push("/journal") },
  { id: "nav-backtest", label: "Backtest", group: "Navigate", run: (r) => r.push("/backtest") },
  { id: "nav-optimize", label: "Optimize", hint: "Walk-forward parameter search", group: "Navigate", run: (r) => r.push("/optimize") },
  { id: "nav-risk", label: "Risk", group: "Navigate", run: (r) => r.push("/risk") },
  { id: "nav-execution", label: "Execution", hint: "TWAP/VWAP/POV simulator", group: "Navigate", run: (r) => r.push("/execution") },
  { id: "nav-rotation", label: "Rotation", group: "Navigate", run: (r) => r.push("/rotation") },
  { id: "nav-reports", label: "Reports", group: "Navigate", run: (r) => r.push("/reports") },
  { id: "nav-earnings", label: "Earnings", group: "Navigate", run: (r) => r.push("/earnings") },
  { id: "nav-news", label: "News events", group: "Navigate", run: (r) => r.push("/news") },
  { id: "nav-stops", label: "Stops", hint: "Stop loss, take profit, trailing", group: "Navigate", run: (r) => r.push("/stops") },
  { id: "nav-correlation", label: "Correlation", hint: "Pairwise + diversification", group: "Navigate", run: (r) => r.push("/correlation") },
  { id: "nav-diversification", label: "Diversification", hint: "Correlation clusters + warnings", group: "Navigate", run: (r) => r.push("/diversification") },
  { id: "nav-ledger", label: "Ledger", hint: "Cash and margin", group: "Navigate", run: (r) => r.push("/ledger") },
  { id: "nav-scaling", label: "Scaling", hint: "R-multiple add/trim plans", group: "Navigate", run: (r) => r.push("/scaling") },
  { id: "nav-fx", label: "FX rates", hint: "Currency conversion", group: "Navigate", run: (r) => r.push("/fx") },
  { id: "nav-notifier", label: "Notifier", hint: "Dead letter queue", group: "Navigate", run: (r) => r.push("/notifier") },
  { id: "nav-webhooks", label: "Webhooks", group: "Navigate", run: (r) => r.push("/webhooks") },
  { id: "nav-digest", label: "Activity digest", group: "Navigate", run: (r) => r.push("/digest") },
];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<CmdItem[]>(() => {
    const base = [...NAV];
    const trimmed = q.trim();
    const sym = trimmed.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
    if (sym.length >= 1 && sym.length <= 8) {
      base.unshift({
        id: `ticker-${sym}`,
        label: `Open ticker ${sym}`,
        hint: "Detail view",
        group: "Actions",
        run: (r) => r.push(`/ticker/${sym}`),
      });
    }
    if (!trimmed) return base;
    const ql = trimmed.toLowerCase();
    return base.filter((i) => i.label.toLowerCase().includes(ql) || (i.hint ?? "").toLowerCase().includes(ql));
  }, [q]);

  useEffect(() => { setActive(0); }, [q]);

  if (!open) return null;

  const run = (it: CmdItem) => {
    setOpen(false);
    it.run(router);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/60 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg panel overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)]">
          <MagnifyingGlass weight="duotone" size={16} className="text-[var(--muted)]" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const it = items[active];
                if (it) run(it);
              }
            }}
            placeholder="Search pages or type a ticker"
            className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-[var(--muted)]"
          />
          <span className="muted text-[10px] uppercase tracking-wide">esc</span>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 && (
            <li className="px-3 py-6 text-center muted text-xs">No matches</li>
          )}
          {items.map((it, i) => (
            <li key={it.id}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => run(it)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left ${
                  i === active ? "bg-white/5" : ""
                }`}
              >
                <span className="flex items-center gap-2">
                  <span>{it.label}</span>
                  {it.hint && <span className="muted text-xs">{it.hint}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="muted text-[10px] uppercase tracking-wide">{it.group}</span>
                  <ArrowRight weight="duotone" size={12} className="text-[var(--muted)]" />
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-[var(--border)] px-3 py-1.5 muted text-[10px] flex items-center justify-between">
          <span>⌘K to toggle</span>
          <span>↑↓ navigate · ↵ select</span>
        </div>
      </div>
    </div>
  );
}
