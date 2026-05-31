"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import RegimeChart, { REGIME_PALETTE } from "@/components/RegimeChart";
import { Card, Stat, Badge, Loading, ErrorBox, Empty, fmtPct } from "@/components/ui";
import {
  Pulse,
  ArrowRight,
  ShieldCheck,
  LightningSlash,
  FloppyDisk,
  Copy,
  Check,
  ClockCounterClockwise,
} from "@phosphor-icons/react/dist/ssr";

// Public demo. No API key required. Calls the unauthenticated
// /public/regime/demo endpoint on the backend.
const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431";

const SAMPLES = [
  { ticker: "SPY", label: "S&P 500", hint: "Broad US equity benchmark" },
  { ticker: "QQQ", label: "Nasdaq 100", hint: "Tech-heavy growth index" },
  { ticker: "IWM", label: "Russell 2000", hint: "US small caps" },
  { ticker: "TLT", label: "20Y Treasuries", hint: "Long-duration bonds" },
  { ticker: "GLD", label: "Gold", hint: "Real-asset hedge" },
  { ticker: "BTC-USD", label: "Bitcoin", hint: "Crypto, 24/7" },
];

const LOOKBACKS = [
  { days: 252, label: "1Y" },
  { days: 504, label: "2Y" },
  { days: 1260, label: "5Y" },
];

type DemoResponse = {
  ticker: string;
  dates: string[];
  close: number[];
  regime: (string | null)[];
  counts: Record<string, number>;
  snapshot: {
    label: string;
    realized_vol: number;
    trend_slope: number;
    drawdown: number;
    confidence: number;
    risk_scale: number;
    as_of: string;
  } | null;
  disclaimer: string;
};

function regimeTone(label: string): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

const VALID_TICKERS = new Set(SAMPLES.map((s) => s.ticker));
const VALID_LOOKBACKS = new Set(LOOKBACKS.map((l) => l.days));

export default function DemoPage() {
  return (
    <Suspense fallback={<div className="max-w-6xl mx-auto p-6"><Loading /></div>}>
      <DemoInner />
    </Suspense>
  );
}

function DemoInner() {
  const params = useSearchParams();
  const qTicker = params.get("ticker");
  const qLook = Number(params.get("lookback"));
  const initialTicker = qTicker && VALID_TICKERS.has(qTicker) ? qTicker : "SPY";
  const initialLookback = VALID_LOOKBACKS.has(qLook) ? qLook : 504;
  const [ticker, setTicker] = useState(initialTicker);
  const [lookback, setLookback] = useState(initialLookback);
  const [data, setData] = useState<DemoResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    const t0 = performance.now();
    fetch(`${BASE}/public/regime/demo?ticker=${encodeURIComponent(ticker)}&lookback_days=${lookback}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        const txt = await r.text();
        if (!r.ok) throw new Error(`${r.status} ${txt || "request failed"}`);
        return JSON.parse(txt) as DemoResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setLatencyMs(Math.round(performance.now() - t0));
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(String(e?.message || e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, lookback]);

  const totalBars = useMemo(
    () => (data?.counts ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0),
    [data]
  );

  const snap = data?.snapshot;
  const currentLabel = snap?.label ?? "--";
  const sample = SAMPLES.find((s) => s.ticker === ticker)!;

  // Clear share state when inputs change so we never show a stale link.
  useEffect(() => {
    setSaved(null);
    setSaveErr(null);
  }, [ticker, lookback]);

  async function saveRun() {
    if (!data) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticker,
          lookback_days: lookback,
          label: `${sample.label} · ${LOOKBACKS.find((l) => l.days === lookback)?.label ?? lookback + "d"}`,
          payload: data,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `${r.status}`);
      const url = `${window.location.origin}/r/${j.id}`;
      setSaved({ id: j.id, url });
    } catch (e: any) {
      setSaveErr(String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function copyShareLink() {
    if (!saved) return;
    try {
      await navigator.clipboard.writeText(saved.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this link:", saved.url);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Hero */}
      <section className="panel p-5 md:p-7">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Pulse size={18} weight="duotone" style={{ color: "var(--amber)" }} />
              <span className="muted text-[10px] uppercase tracking-widest mono">
                Live demo, no signup
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
              See the market{" "}
              <span style={{ color: "var(--amber)" }}>regime classifier</span> in action
            </h1>
            <p className="muted text-[13px] max-w-2xl">
              SignalClaw labels every trading day as bull, chop, bear, or crash from realized
              volatility, trend slope, and drawdown. Pick a sample below to run the model on
              real price history right now.
            </p>
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <Link
              href="/history"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              <ClockCounterClockwise size={12} weight="bold" /> History
            </Link>
            <Link
              href="/regime"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              Full terminal <ArrowRight size={12} weight="bold" />
            </Link>
          </div>
        </div>
      </section>

      {/* Sample picker */}
      <Card
        title="Try a sample"
        right={
          <div className="flex items-center gap-1.5">
            {LOOKBACKS.map((lb) => (
              <button
                key={lb.days}
                onClick={() => setLookback(lb.days)}
                aria-pressed={lookback === lb.days}
                className={`text-[10px] px-2 py-1 rounded-sm border uppercase tracking-widest font-semibold mono ${
                  lookback === lb.days
                    ? "bg-[var(--amber)]/15 text-[var(--amber)] border-[var(--amber)]/40"
                    : "border-[var(--border-strong)] muted hover:bg-white/5"
                }`}
              >
                {lb.label}
              </button>
            ))}
          </div>
        }
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {SAMPLES.map((s) => {
            const active = s.ticker === ticker;
            return (
              <button
                key={s.ticker}
                onClick={() => setTicker(s.ticker)}
                aria-pressed={active}
                className={`text-left p-3 rounded-sm border transition ${
                  active
                    ? "border-[var(--amber)]/60 bg-[var(--amber)]/10"
                    : "border-[var(--border-strong)] hover:bg-white/5"
                }`}
              >
                <div className="mono text-[11px] font-semibold">{s.ticker}</div>
                <div className="text-[12px] mt-0.5">{s.label}</div>
                <div className="muted text-[10px] mt-0.5">{s.hint}</div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Snapshot stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card title="Current regime">
          {loading && !snap ? (
            <SkelStat />
          ) : err ? (
            <span className="muted text-[12px]">error</span>
          ) : snap ? (
            <div className="flex items-center gap-2">
              <Badge tone={regimeTone(currentLabel)}>{currentLabel.toUpperCase()}</Badge>
              <span className="muted text-[10px] mono uppercase">
                conf {(snap.confidence * 100).toFixed(0)}%
              </span>
            </div>
          ) : (
            <Empty title="no data" />
          )}
        </Card>
        <Stat
          label="Realized vol"
          value={snap ? fmtPct(snap.realized_vol) : "--"}
          delta="Annualized, 20d"
        />
        <Stat
          label="Trend slope"
          value={snap ? (snap.trend_slope >= 0 ? "+" : "") + snap.trend_slope.toFixed(4) : "--"}
          delta="OLS on log price"
          tone={snap ? (snap.trend_slope >= 0 ? "up" : "down") : undefined}
        />
        <Stat
          label="Drawdown"
          value={snap ? fmtPct(snap.drawdown) : "--"}
          delta="From recent high"
          tone={snap && snap.drawdown < -0.05 ? "down" : undefined}
        />
      </div>

      {/* Save & share strip */}
      <Card title="Save this run">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="muted text-[11px] flex-1">
            Snapshot the chart, stats, and regime mix to a permanent URL anyone can open.
            No signup required.
          </p>
          {saved ? (
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-[11px] mono px-2 py-1.5 rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] truncate max-w-[280px]">
                {saved.url}
              </code>
              <button
                onClick={copyShareLink}
                className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
              >
                {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />}
                {copied ? "Copied" : "Copy link"}
              </button>
              <Link
                href={`/r/${saved.id}`}
                className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)] uppercase tracking-widest font-semibold mono"
              >
                Open
              </Link>
            </div>
          ) : (
            <button
              onClick={saveRun}
              disabled={saving || !data || !!err}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)] uppercase tracking-widest font-semibold mono flex items-center gap-1.5 disabled:opacity-40"
            >
              <FloppyDisk size={12} weight="bold" />
              {saving ? "Saving" : "Save & share"}
            </button>
          )}
        </div>
        {saveErr && (
          <div className="text-[11px] mt-2" style={{ color: "var(--red)" }}>
            Could not save: {saveErr}
          </div>
        )}
      </Card>

      {/* Chart */}
      <Card
        title={`${sample.label} · regime overlay`}
        right={
          <div className="flex items-center gap-2">
            {latencyMs != null && (
              <span className="muted text-[10px] mono uppercase tracking-widest">
                {latencyMs}ms
              </span>
            )}
            <span className="mono text-[10px] muted">{data?.ticker ?? ""}</span>
          </div>
        }
      >
        {err ? (
          <ErrorBox err={err} />
        ) : loading && !data ? (
          <div className="h-[380px] flex items-center justify-center">
            <Loading />
          </div>
        ) : data && data.dates.length > 0 ? (
          <>
            <RegimeChart dates={data.dates} close={data.close} regime={data.regime} />
            <Legend />
          </>
        ) : (
          <Empty title="no data for this ticker" />
        )}
      </Card>

      {/* Regime mix */}
      <Card title="Regime mix over window">
        {loading && !data ? (
          <div className="h-12 rounded-sm bg-white/5 animate-pulse" />
        ) : data && totalBars > 0 ? (
          <div className="space-y-2">
            <div className="flex h-3 rounded-sm overflow-hidden border border-[var(--border)]">
              {(["bull", "chop", "bear", "crash"] as const).map((k) => {
                const v = data.counts[k] || 0;
                const pct = (v / totalBars) * 100;
                if (pct <= 0) return null;
                return (
                  <div
                    key={k}
                    title={`${k}: ${v} bars (${pct.toFixed(1)}%)`}
                    style={{ width: `${pct}%`, background: REGIME_PALETTE[k] }}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-3 text-[11px] mono uppercase tracking-widest">
              {(["bull", "chop", "bear", "crash"] as const).map((k) => {
                const v = data.counts[k] || 0;
                if (v === 0) return null;
                return (
                  <div key={k} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full"
                      style={{ background: REGIME_PALETTE[k] }}
                    />
                    <span>{k}</span>
                    <span className="muted">{((v / totalBars) * 100).toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <Empty title="no bars classified" />
        )}
      </Card>

      {/* Trust footer */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="panel p-4">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} weight="duotone" style={{ color: "var(--green)" }} />
            <div>
              <div className="text-[12px] font-semibold mb-1">Real model, real data</div>
              <p className="muted text-[11px]">
                Predictions come from the same regime classifier the full terminal uses,
                over OHLCV pulled from public market feeds.
              </p>
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="flex items-start gap-3">
            <LightningSlash size={18} weight="duotone" style={{ color: "var(--amber)" }} />
            <div>
              <div className="text-[12px] font-semibold mb-1">Not financial advice</div>
              <p className="muted text-[11px]">
                {data?.disclaimer ??
                  "SignalClaw is research tooling. Outputs may be wrong. Do your own work."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SkelStat() {
  return <div className="h-5 w-24 rounded-sm bg-white/10 animate-pulse" />;
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-4 mt-3 text-[11px] mono uppercase tracking-widest">
      {(["bull", "chop", "bear", "crash"] as const).map((k) => (
        <div key={k} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ background: REGIME_PALETTE[k] }}
          />
          <span>{k}</span>
        </div>
      ))}
    </div>
  );
}
