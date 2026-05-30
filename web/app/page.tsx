"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, fmtPct } from "@/components/ui";
import { swrFetcher, type DailyReport, type Regime, type Pick } from "@/lib/api";
import { Pulse, ShieldWarning, TrendUp, Eye, Prohibit, Lightning, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

export default function Page() {
  return (
    <AuthGate>
      <Today />
    </AuthGate>
  );
}

function regimeTone(label: string): "up" | "down" | "warn" | "info" {
  switch (label) {
    case "bull": return "up";
    case "neutral": return "info";
    case "chop": return "warn";
    case "bear":
    case "crash": return "down";
    default: return "info";
  }
}

function Today() {
  const [guarded, setGuarded] = useState(false);
  const picksKey = guarded ? "/picks/guarded" : "/picks";
  const picks = useSWR<DailyReport>(picksKey, swrFetcher, { refreshInterval: 60000 });
  const reg = useSWR<Regime>("/regime?ticker=SPY", swrFetcher, { refreshInterval: 60000 });

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="panel p-3 text-xs flex items-start gap-2">
        <ShieldWarning weight="duotone" className="text-[var(--amber)] shrink-0 mt-0.5" size={16} />
        <div>
          <strong className="text-[var(--amber)]">NOT FINANCIAL ADVICE.</strong>{" "}
          SignalClaw is a personal research tool. Outputs may be wrong.
        </div>
      </div>

      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Today {picks.data && <span className="muted text-sm font-normal">{picks.data.as_of}</span>}</h1>
          <p className="muted text-xs">Daily picks scored against the SPY market regime.</p>
        </div>
        <RegimeBanner reg={reg.data} loading={!reg.data && !reg.error} err={reg.error} />
      </header>

      <Card
        title="Signals"
        right={
          <button
            onClick={() => setGuarded((g) => !g)}
            className={`text-xs px-2 py-1 rounded border flex items-center gap-1.5 ${
              guarded
                ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30"
                : "border-[var(--border)] muted hover:text-white"
            }`}
            aria-pressed={guarded}
            title="Filter picks through portfolio drawdown guard"
          >
            <ShieldCheck weight="duotone" size={14} />
            {guarded ? "Guard on" : "Guard off"}
          </button>
        }
      >
        {picks.error ? <ErrorBox err={picks.error} /> :
          !picks.data ? <Loading label={guarded ? "Applying drawdown guard" : "Fetching picks"} /> :
            picks.data.picks.length === 0 ? (
              <Empty
                title={guarded ? "No picks survive the guard" : "No picks for today"}
                hint={guarded
                  ? "Drawdown guard is suppressing signals. Toggle it off or review portfolio risk."
                  : "Watchlist may be empty or the pipeline has not run."}
              />
            ) : (
              <PicksTable picks={picks.data.picks} riskScale={reg.data?.risk_scale ?? 1} />
            )}
      </Card>
    </div>
  );
}

function RegimeBanner({ reg, loading, err }: { reg?: Regime; loading: boolean; err: unknown }) {
  if (err) return <div className="text-xs down">regime unavailable</div>;
  if (loading || !reg) return <div className="muted text-xs">regime loading</div>;
  const tone = regimeTone(reg.label);
  return (
    <div className="panel p-3 flex flex-wrap items-center gap-4 text-xs">
      <div className="flex items-center gap-2">
        <Pulse weight="duotone" size={18} className="text-[var(--accent)]" />
        <span className="muted">SPY regime</span>
        <Badge tone={tone}>{reg.label}</Badge>
      </div>
      <RegStat label="vol" value={fmtPct(reg.realized_vol)} />
      <RegStat label="trend" value={(reg.trend_slope * 1e4).toFixed(2) + " bps/d"} />
      <RegStat label="drawdown" value={fmtPct(reg.drawdown)} />
      <RegStat label="risk scale" value={`${reg.risk_scale.toFixed(2)}x`} />
      <RegStat label="confidence" value={fmtPct(reg.confidence)} />
    </div>
  );
}

function RegStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="muted uppercase tracking-wide">{label}</span>
      <span className="num text-white">{value}</span>
    </span>
  );
}

function labelIcon(l: string) {
  if (l === "watch") return <Eye weight="duotone" className="inline" />;
  if (l === "skip") return <Prohibit weight="duotone" className="inline" />;
  if (l === "hold") return <TrendUp weight="duotone" className="inline" />;
  return <Lightning weight="duotone" className="inline" />;
}

function labelTone(l: string): "up" | "down" | "warn" | "neutral" {
  if (l === "watch") return "up";
  if (l === "skip") return "down";
  if (l === "hold") return "warn";
  return "neutral";
}

function PicksTable({ picks, riskScale }: { picks: Pick[]; riskScale: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted text-xs uppercase tracking-wide border-b border-[var(--border)]">
            <th className="py-2 pr-3">Ticker</th>
            <th className="pr-3">Label</th>
            <th className="text-right pr-3">Score</th>
            <th className="text-right pr-3">Expected 5d</th>
            <th className="text-right pr-3">Regime adj</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((p) => (
            <tr key={p.ticker} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
              <td className="py-2 pr-3 mono">
                <Link href={`/ticker/${p.ticker}`} className="hover:text-[var(--accent)]">{p.ticker}</Link>
              </td>
              <td className="pr-3">
                <Badge tone={labelTone(p.label)}>
                  <span className="mr-1">{labelIcon(p.label)}</span>{p.label}
                </Badge>
              </td>
              <td className="num text-right pr-3">{p.score.toFixed(2)}</td>
              <td className={`num text-right pr-3 ${p.expected_return >= 0 ? "up" : "down"}`}>
                {fmtPct(p.expected_return)}
              </td>
              <td className="num text-right pr-3 muted">
                {fmtPct(p.expected_return * riskScale)}
              </td>
              <td className="muted text-xs">
                {p.rationale}
                {p.risk_flags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.risk_flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
