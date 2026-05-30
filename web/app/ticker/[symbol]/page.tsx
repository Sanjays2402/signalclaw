"use client";
import useSWR from "swr";
import Link from "next/link";
import { use } from "react";
import AuthGate from "@/components/AuthGate";
import EquityChart from "@/components/EquityChart";
import { Card, Stat, Badge, Loading, ErrorBox, Empty, fmtPct, Button } from "@/components/ui";
import { swrFetcher, api, type Backtest, type Regime } from "@/lib/api";
import { ArrowLeft, ChartLine, Pulse, WarningOctagon, Plus } from "@phosphor-icons/react/dist/ssr";

type AnomalyReport = {
  ticker: string;
  n_bars: number;
  n_anomalous: number;
  rate: number;
  anomalies: { date: string; reason: string; z: number; severity: string }[];
};

export default function Page({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  return (
    <AuthGate>
      <Detail symbol={symbol.toUpperCase()} />
    </AuthGate>
  );
}

function Detail({ symbol }: { symbol: string }) {
  const bt = useSWR<Backtest>(`/backtest/${symbol}`, swrFetcher);
  const reg = useSWR<Regime>(`/regime?ticker=${symbol}`, swrFetcher);
  const anom = useSWR<AnomalyReport>(`/quality/anomalies/${symbol}`, swrFetcher, {
    shouldRetryOnError: false,
  });

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/watchlist" className="muted hover:text-white inline-flex items-center gap-1 text-sm">
            <ArrowLeft weight="duotone" size={14} /> watchlist
          </Link>
          <h1 className="text-2xl font-semibold mono">{symbol}</h1>
          {reg.data && <Badge tone={toneFor(reg.data.label)}>{reg.data.label}</Badge>}
        </div>
        <div className="flex gap-2">
          <AddToWatchlist symbol={symbol} />
          <Button
            variant="ghost"
            onClick={() => {
              bt.mutate();
              reg.mutate();
              anom.mutate();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <RegimeStat reg={reg.data} loading={!reg.data && !reg.error} err={reg.error} />
      </div>

      <Card title="Walk-forward backtest" right={<ChartLine weight="duotone" className="text-[var(--accent)]" size={16} />}>
        {bt.error ? <ErrorBox err={bt.error} /> :
          !bt.data ? <Loading label="Running backtest" /> :
            bt.data.dates.length === 0 ? <Empty title="No backtest data" hint="Try refreshing the OHLCV cache." /> :
              <BacktestBody bt={bt.data} />}
      </Card>

      <Card title="OHLCV anomalies" right={<WarningOctagon weight="duotone" className="text-[var(--amber)]" size={16} />}>
        {anom.error ? <AnomEmpty err={anom.error} /> :
          !anom.data ? <Loading label="Scanning bars" /> :
            anom.data.anomalies.length === 0 ? (
              <Empty title="No anomalies flagged" hint={`${anom.data.n_bars} bars scanned.`} />
            ) : (
              <AnomaliesTable rep={anom.data} />
            )}
      </Card>
    </div>
  );
}

function toneFor(label: string): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

function RegimeStat({ reg, loading, err }: { reg?: Regime; loading: boolean; err: unknown }) {
  if (err) return <Stat label="regime" value="n/a" />;
  if (loading || !reg) {
    return (
      <>
        <Stat label="vol" value="…" />
        <Stat label="trend" value="…" />
        <Stat label="drawdown" value="…" />
        <Stat label="risk scale" value="…" />
      </>
    );
  }
  return (
    <>
      <Stat label="realized vol" value={fmtPct(reg.realized_vol)} />
      <Stat label="trend" value={`${(reg.trend_slope * 1e4).toFixed(2)} bps/d`} />
      <Stat label="drawdown" value={fmtPct(reg.drawdown)} tone={reg.drawdown < -0.05 ? "down" : "neutral"} />
      <Stat label="risk scale" value={`${reg.risk_scale.toFixed(2)}x`} />
    </>
  );
}

function BacktestBody({ bt }: { bt: Backtest }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <KV k="Sharpe" v={bt.sharpe.toFixed(2)} />
        <KV k="Sortino" v={bt.sortino.toFixed(2)} />
        <KV k="Max DD" v={fmtPct(bt.max_drawdown)} tone="down" />
        <KV k="Hit rate" v={fmtPct(bt.hit_rate)} />
        <KV k="CAGR" v={fmtPct(bt.cagr)} tone={bt.cagr >= 0 ? "up" : "down"} />
        <KV k="Trades" v={String(bt.n_trades)} />
      </div>
      <EquityChart dates={bt.dates} values={bt.equity_curve} />
    </div>
  );
}

function KV({ k, v, tone }: { k: string; v: string; tone?: "up" | "down" }) {
  const cls = tone === "up" ? "up" : tone === "down" ? "down" : "";
  return (
    <div className="panel p-3">
      <div className="muted text-xs uppercase tracking-wide">{k}</div>
      <div className={`num text-lg ${cls}`}>{v}</div>
    </div>
  );
}

function AnomEmpty({ err }: { err: unknown }) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("404")) {
    return <Empty title="No OHLCV cached" hint="Run a backtest above to seed the cache, then refresh." />;
  }
  return <ErrorBox err={err} />;
}

function AnomaliesTable({ rep }: { rep: AnomalyReport }) {
  return (
    <div className="space-y-2">
      <div className="muted text-xs">
        {rep.n_anomalous} of {rep.n_bars} bars flagged ({fmtPct(rep.rate)})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left muted text-xs uppercase tracking-wide border-b border-[var(--border)]">
              <th className="py-2 pr-3">Date</th>
              <th className="pr-3">Severity</th>
              <th className="text-right pr-3">Z</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rep.anomalies.slice(0, 50).map((a, i) => (
              <tr key={`${a.date}-${i}`} className="border-b border-[var(--border)]">
                <td className="py-2 pr-3 mono">{a.date}</td>
                <td className="pr-3">
                  <Badge tone={a.severity === "high" ? "down" : a.severity === "medium" ? "warn" : "info"}>
                    {a.severity}
                  </Badge>
                </td>
                <td className="num text-right pr-3">{a.z?.toFixed?.(2) ?? "n/a"}</td>
                <td className="muted text-xs">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddToWatchlist({ symbol }: { symbol: string }) {
  return (
    <Button
      variant="ghost"
      onClick={async () => {
        try {
          await api("/watchlist", { method: "POST", body: JSON.stringify({ ticker: symbol }) });
        } catch {
          /* idempotent on backend; ignore */
        }
      }}
    >
      <Plus weight="duotone" className="inline mr-1" size={14} /> Watch
    </Button>
  );
}
