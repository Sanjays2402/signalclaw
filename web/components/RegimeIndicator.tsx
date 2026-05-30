"use client";
import useSWR from "swr";
import { swrFetcher, type Regime } from "@/lib/api";

export type RegimeBucket = "BULL" | "CHOP" | "BEAR" | "CRASH" | "NEUTRAL";

export function bucket(label?: string, dd?: number): RegimeBucket {
  if (!label) return "NEUTRAL";
  const l = label.toLowerCase();
  if (l === "bull") return "BULL";
  if (l === "chop") return "CHOP";
  if (l === "bear") return "BEAR";
  if (l === "crash") return (dd != null && dd < -0.15) ? "CRASH" : "BEAR";
  if (l === "neutral") return "NEUTRAL";
  return "NEUTRAL";
}

const TONE: Record<RegimeBucket, string> = {
  BULL: "regime-bull",
  CHOP: "regime-chop",
  BEAR: "regime-bear",
  CRASH: "regime-crash",
  NEUTRAL: "regime-neutral",
};

export default function RegimeIndicator({ compact = false }: { compact?: boolean }) {
  const { data, error } = useSWR<Regime>("/regime?ticker=SPY", swrFetcher, {
    refreshInterval: 60000,
    shouldRetryOnError: false,
  });

  const b = bucket(data?.label, data?.drawdown);
  const cls = TONE[b];
  const risk = data?.risk_scale ?? 1.0;

  if (compact) {
    return (
      <span className={`regime-pill ${cls}`} title={data ? `risk_scale ${risk.toFixed(2)}x` : "regime"}>
        <span>{b}</span>
        <span className="mono" style={{ fontWeight: 600, opacity: 0.75 }}>
          {error ? "--" : `${risk.toFixed(2)}x`}
        </span>
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className={`regime-pill ${cls}`}>{b}</span>
      <span className="muted text-[10px] uppercase tracking-widest">Risk</span>
      <span className="mono text-sm" style={{ color: "var(--fg)" }}>
        {error ? "n/a" : `${risk.toFixed(2)}x`}
      </span>
    </div>
  );
}
