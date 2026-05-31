"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import RegimeChart, { REGIME_PALETTE } from "@/components/RegimeChart";
import {
  Card,
  Stat,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  fmtPct,
} from "@/components/ui";
import { swrFetcher, type RegimeSeries } from "@/lib/api";
import { ChartLineUp, Pulse, Waveform, Scales } from "@phosphor-icons/react/dist/ssr";

const SAMPLES: { ticker: string; label: string; hint: string }[] = [
  { ticker: "SPY", label: "S&P 500", hint: "Broad US equity benchmark" },
  { ticker: "QQQ", label: "Nasdaq 100", hint: "Tech-heavy growth index" },
  { ticker: "IWM", label: "Russell 2000", hint: "US small caps" },
  { ticker: "TLT", label: "20Y Treasuries", hint: "Long-duration bonds" },
  { ticker: "GLD", label: "Gold", hint: "Real-asset hedge" },
  { ticker: "BTC-USD", label: "Bitcoin", hint: "Crypto, 24/7" },
];

const LOOKBACKS: { days: number; label: string }[] = [
  { days: 126, label: "6M" },
  { days: 252, label: "1Y" },
  { days: 504, label: "2Y" },
  { days: 1260, label: "5Y" },
];

export default function Page() {
  return (
    <AuthGate>
      <RegimePage />
    </AuthGate>
  );
}

function regimeTone(label: string): "up" | "down" | "warn" | "info" {
  switch (label) {
    case "bull":
      return "up";
    case "chop":
      return "warn";
    case "bear":
    case "crash":
      return "down";
    default:
      return "info";
  }
}

function statTone(label: string): "up" | "down" | "neutral" | "warn" {
  switch (label) {
    case "bull":
      return "up";
    case "chop":
      return "warn";
    case "bear":
    case "crash":
      return "down";
    default:
      return "neutral";
  }
}

function RegimePage() {
  const [ticker, setTicker] = useState("SPY");
  const [lookback, setLookback] = useState(504);
  const key = `/regime/series?ticker=${encodeURIComponent(ticker)}&lookback_days=${lookback}`;
  const { data, error, isLoading } = useSWR<RegimeSeries>(key, swrFetcher, {
    refreshInterval: 5 * 60 * 1000,
    shouldRetryOnError: false,
  });

  const counts = data?.counts ?? {};
  const totalLabeled = Object.values(counts).reduce((a, b) => a + b, 0);
  const labeledShare = useMemo(() => {
    const out: { name: string; pct: number; n: number }[] = [];
    for (const name of ["bull", "chop", "bear", "crash"] as const) {
      const n = counts[name] ?? 0;
      out.push({ name, n, pct: totalLabeled ? n / totalLabeled : 0 });
    }
    return out;
  }, [counts, totalLabeled]);

  const snap = data?.snapshot ?? null;

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Hero / explainer */}
      <Card
        title={
          <span className="flex items-center gap-2">
            <ChartLineUp weight="duotone" size={16} />
            Regime classifier
          </span>
        }
        right={
          snap ? (
            <Badge tone={regimeTone(snap.label)}>
              {snap.label}
            </Badge>
          ) : null
        }
      >
        <p className="text-[12px] leading-relaxed text-[var(--fg-muted)] max-w-3xl">
          Live classification of any ticker into bull, chop, bear, or crash using
          realized volatility, 60-day trend slope, and 252-day drawdown. The same
          model that gates position sizing in the daily picks engine. Pick a sample
          below or type a ticker to see how the regime label moves through history.
        </p>
      </Card>

      {/* Sample selector + ticker input */}
      <Card title="Try a sample">
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.ticker}
              onClick={() => setTicker(s.ticker)}
              aria-pressed={ticker === s.ticker}
              className={`text-left px-3 py-2 rounded-sm border transition-colors min-w-[160px] focus:outline-none focus:ring-1 focus:ring-[var(--amber)] ${
                ticker === s.ticker
                  ? "bg-[var(--amber)]/15 border-[var(--amber)]/50"
                  : "bg-[var(--bg-elev)] border-[var(--border)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="mono text-[11px] font-semibold">{s.ticker}</div>
              <div className="text-[11px]">{s.label}</div>
              <div className="text-[10px] text-[var(--fg-muted)] mt-0.5">{s.hint}</div>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
              Custom ticker
            </span>
            <input
              value={ticker}
              onChange={(e) => setTicker(e.target.value.toUpperCase().trim())}
              spellCheck={false}
              maxLength={12}
              className="mono text-[12px] px-2 py-1 rounded-sm bg-[var(--bg-elev)] border border-[var(--border)] focus:border-[var(--amber)] focus:outline-none w-32"
              aria-label="Ticker symbol"
            />
          </label>
          <div className="flex items-center gap-1">
            {LOOKBACKS.map((lb) => (
              <Button
                key={lb.days}
                onClick={() => setLookback(lb.days)}
                variant={lookback === lb.days ? "primary" : "ghost"}
                aria-pressed={lookback === lb.days}
              >
                {lb.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* Snapshot stats */}
      {snap && !isLoading && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <Stat label="Label" value={snap.label.toUpperCase()} delta={`as of ${snap.as_of}`} tone={statTone(snap.label)} />
          <Stat label="Confidence" value={fmtPct(snap.confidence)} />
          <Stat label="Realized vol" value={fmtPct(snap.realized_vol)} delta="annualized, 20d" />
          <Stat label="Drawdown" value={fmtPct(snap.drawdown)} delta="from 252d high" tone={snap.drawdown <= -0.1 ? "down" : "neutral"} />
          <Stat
            label="Risk scale"
            value={`${snap.risk_scale.toFixed(2)}x`}
            delta="position-size multiplier"
          />
        </div>
      )}

      {/* Chart */}
      <Card
        title={
          <span className="flex items-center gap-2">
            <Waveform weight="duotone" size={16} />
            {data?.ticker ?? ticker} · price with regime overlay
          </span>
        }
        right={<LegendDots />}
      >
        {isLoading && <Loading label="Classifying" />}
        {error && <ErrorBox err={error} />}
        {!isLoading && !error && data && data.dates.length > 0 && (
          <RegimeChart dates={data.dates} close={data.close} regime={data.regime} />
        )}
        {!isLoading && !error && data && data.dates.length === 0 && (
          <Empty title="No bars" hint="Try a different ticker or lookback" />
        )}
      </Card>

      {/* Bars per regime */}
      {data && totalLabeled > 0 && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <Scales weight="duotone" size={16} />
              Time spent in each regime
            </span>
          }
          right={
            <span className="mono text-[10px] text-[var(--fg-muted)]">
              {totalLabeled} bars
            </span>
          }
        >
          <div className="space-y-2">
            {labeledShare.map((row) => (
              <div key={row.name} className="grid grid-cols-12 items-center gap-2">
                <div className="col-span-2 mono text-[11px] uppercase">{row.name}</div>
                <div className="col-span-8 h-3 rounded-sm bg-[var(--bg-elev)] overflow-hidden border border-[var(--border)]">
                  <div
                    className="h-full"
                    style={{
                      width: `${(row.pct * 100).toFixed(1)}%`,
                      background: REGIME_PALETTE[row.name] ?? "#6C7388",
                    }}
                    role="progressbar"
                    aria-valuenow={Math.round(row.pct * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${row.name} ${(row.pct * 100).toFixed(1)} percent`}
                  />
                </div>
                <div className="col-span-2 mono text-[11px] text-right">
                  {fmtPct(row.pct)} · {row.n}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-[var(--fg-muted)] mt-3 flex items-center gap-1.5">
            <Pulse weight="duotone" size={12} />
            Risk scale is applied to position sizes by the daily picks engine.
            Bear scales 0.5x, crash 0.25x, chop 0.75x, bull 1.25x.
          </p>
        </Card>
      )}
    </div>
  );
}

function LegendDots() {
  return (
    <div className="flex items-center gap-3">
      {(["bull", "chop", "bear", "crash"] as const).map((r) => (
        <div key={r} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: REGIME_PALETTE[r] }}
            aria-hidden
          />
          <span className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
            {r}
          </span>
        </div>
      ))}
    </div>
  );
}
