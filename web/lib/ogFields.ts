// Pure formatters for the /r/[id] OG image. Kept separate so unit tests
// can verify rendered numbers without booting next/og.
import type { SavedRun } from "@/lib/runStore";

export type OgFields = {
  ticker: string;
  label: string;
  conf: string;
  vol: string;
  dd: string;
  bars: number;
  color: string;
};

export const OG_REGIME_COLORS: Record<string, string> = {
  bull: "#34d399",
  chop: "#fbbf24",
  bear: "#f87171",
  crash: "#ef4444",
};

export function ogFields(run: SavedRun | null, id: string): OgFields & { id: string } {
  const ticker = run?.ticker ?? "UNKNOWN";
  const snap = run?.payload.snapshot ?? null;
  const label = (snap?.label ?? "no-snapshot").toUpperCase();
  const conf = snap ? `${Math.round(snap.confidence * 100)}%` : "--";
  const vol = snap ? `${(snap.realized_vol * 100).toFixed(1)}%` : "--";
  const dd = snap ? `${(snap.drawdown * 100).toFixed(1)}%` : "--";
  const bars = run?.payload.dates.length ?? 0;
  const color = OG_REGIME_COLORS[snap?.label ?? ""] ?? "#a3a3a3";
  return { id, ticker, label, conf, vol, dd, bars, color };
}
