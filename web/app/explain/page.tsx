"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import Sparkline from "@/components/Sparkline";
import {
  Card,
  Stat,
  Badge,
  Button,
  Loading,
  ErrorBox,
  Empty,
  fmtPct,
  fmtPctSigned,
} from "@/components/ui";
import { swrFetcher, type Explain } from "@/lib/api";
import {
  Lightbulb,
  ChartLineUp,
  Warning,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Sparkle,
} from "@phosphor-icons/react/dist/ssr";

const SAMPLES: { ticker: string; label: string; hint: string }[] = [
  { ticker: "SPY", label: "S&P 500", hint: "Broad US equity benchmark" },
  { ticker: "QQQ", label: "Nasdaq 100", hint: "Tech-heavy growth index" },
  { ticker: "AAPL", label: "Apple", hint: "Mega-cap consumer tech" },
  { ticker: "NVDA", label: "NVIDIA", hint: "AI accelerator leader" },
  { ticker: "TLT", label: "20Y Treasuries", hint: "Long-duration bonds" },
  { ticker: "BTC-USD", label: "Bitcoin", hint: "Crypto, 24/7" },
];

const LOOKBACKS = [
  { days: 60, label: "3M" },
  { days: 120, label: "6M" },
  { days: 252, label: "1Y" },
  { days: 504, label: "2Y" },
];

export default function Page() {
  return (
    <AuthGate>
      <ExplainPage />
    </AuthGate>
  );
}

function labelTone(label: string): "up" | "down" | "warn" | "info" {
  if (label === "watch") return "up";
  if (label === "skip") return "down";
  if (label === "hold") return "warn";
  return "info";
}

function directionIcon(direction: string) {
  if (direction === "bullish") return <ArrowUpRight size={14} weight="duotone" />;
  if (direction === "bearish") return <ArrowDownRight size={14} weight="duotone" />;
  return <Minus size={14} weight="duotone" />;
}

function directionColor(direction: string): string {
  if (direction === "bullish") return "var(--green)";
  if (direction === "bearish") return "var(--red)";
  return "var(--muted)";
}

function ExplainPage() {
  const [ticker, setTicker] = useState("SPY");
  const [lookback, setLookback] = useState(120);
  const [draft, setDraft] = useState("");

  const key = `/explain/${encodeURIComponent(ticker)}?lookback_days=${lookback}`;
  const { data, error, isLoading } = useSWR<Explain>(key, swrFetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  const bullish = useMemo(
    () => (data?.features ?? []).filter((f) => f.direction === "bullish").slice(0, 6),
    [data]
  );
  const bearish = useMemo(
    () => (data?.features ?? []).filter((f) => f.direction === "bearish").slice(0, 6),
    [data]
  );

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const t = draft.trim().toUpperCase();
    if (t && t !== ticker) {
      setTicker(t);
      setDraft("");
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Lightbulb size={18} weight="duotone" style={{ color: "var(--amber)" }} />
          <h1 className="text-lg font-semibold tracking-tight">Explain a signal</h1>
        </div>
        <p className="text-[12px] muted max-w-2xl">
          Pick any ticker. The model runs the same per-ticker pipeline used by daily picks (technical features, ensemble classifier, return regressor) and shows you the prediction with the indicators that drove it.
        </p>
      </header>

      <Card title="Pick a ticker" right={<span className="muted mono text-[10px] uppercase tracking-widest">/explain/{ticker}</span>}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {SAMPLES.map((s) => (
              <button
                key={s.ticker}
                onClick={() => setTicker(s.ticker)}
                title={s.hint}
                className={`px-2.5 py-1.5 text-[11px] rounded-sm border mono uppercase tracking-wider transition-colors ${
                  ticker === s.ticker
                    ? "bg-[var(--amber)]/15 text-[var(--amber)] border-[var(--amber)]/40"
                    : "border-[var(--border)] hover:border-[var(--border-strong)]"
                }`}
              >
                <span className="font-semibold">{s.ticker}</span>
                <span className="muted ml-1.5 normal-case tracking-normal">{s.label}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 items-center">
            <form onSubmit={submit} className="flex items-center gap-1.5">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Custom ticker (e.g. MSFT)"
                className="px-2 py-1.5 text-[12px] bg-[var(--bg)] border border-[var(--border)] rounded-sm mono uppercase tracking-wider w-44 focus:outline-none focus:border-[var(--amber)]"
                maxLength={12}
                aria-label="Custom ticker"
              />
              <Button type="submit">Load</Button>
            </form>
            <div className="flex items-center gap-1">
              {LOOKBACKS.map((lb) => (
                <button
                  key={lb.days}
                  onClick={() => setLookback(lb.days)}
                  className={`px-2 py-1 text-[10px] rounded-sm border mono uppercase tracking-widest ${
                    lookback === lb.days
                      ? "bg-[var(--bg-elev)] border-[var(--border-strong)]"
                      : "border-[var(--border)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {lb.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {isLoading && <Loading label="Running ensemble on latest features" />}
      {error && <ErrorBox err={error} />}

      {data && (
        <>
          <Card
            title={`${data.ticker} · ${data.as_of}`}
            right={
              <Badge tone={labelTone(data.label)}>
                <Sparkle size={11} weight="duotone" /> {data.label.toUpperCase()}
              </Badge>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Composite score" value={data.score.toFixed(2)} tone={data.score > 0 ? "up" : data.score < 0 ? "down" : "neutral"} />
              <Stat label="Expected 5d return" value={fmtPctSigned(data.expected_return)} tone={data.expected_return > 0 ? "up" : "down"} />
              <Stat label="P(watch)" value={fmtPct(data.proba.watch)} tone="up" />
              <Stat label="P(skip)" value={fmtPct(data.proba.skip)} tone="down" />
            </div>

            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-widest muted mb-2 flex items-center gap-1.5">
                <ChartLineUp size={12} weight="duotone" /> Price · {data.dates.length} bars
              </div>
              <div className="h-24">
                <Sparkline data={data.close} color={data.score > 0 ? "var(--green)" : "var(--red)"} width={1000} height={96} fill />
              </div>
              <div className="flex justify-between mt-1 mono text-[10px] muted">
                <span>{data.dates[0]}</span>
                <span>{data.close[0]?.toFixed(2)} → {data.close[data.close.length - 1]?.toFixed(2)}</span>
                <span>{data.dates[data.dates.length - 1]}</span>
              </div>
            </div>

            <div className="mt-4">
              <div className="text-[10px] uppercase tracking-widest muted mb-2">Class probabilities</div>
              <ProbBar proba={data.proba} />
            </div>

            <div className="mt-4 p-3 bg-[var(--bg)] border border-[var(--border)] rounded-sm">
              <div className="text-[10px] uppercase tracking-widest muted mb-1">Rationale</div>
              <p className="text-[12px] leading-relaxed">{data.rationale}</p>
            </div>

            {data.risk_flags.length > 0 && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <Warning size={12} weight="duotone" style={{ color: "var(--amber)" }} />
                <span className="text-[10px] uppercase tracking-widest muted">Risk flags</span>
                {data.risk_flags.map((f) => (
                  <Badge key={f} tone="warn">{f}</Badge>
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card title="Bullish signals" right={<Badge tone="up">{bullish.length}</Badge>}>
              {bullish.length === 0 ? (
                <Empty title="No bullish features" hint="Nothing in the feature row is pulling positive." />
              ) : (
                <FeatureList items={bullish} />
              )}
            </Card>
            <Card title="Bearish signals" right={<Badge tone="down">{bearish.length}</Badge>}>
              {bearish.length === 0 ? (
                <Empty title="No bearish features" hint="Nothing in the feature row is pulling negative." />
              ) : (
                <FeatureList items={bearish} />
              )}
            </Card>
          </div>

          <Card title="All features" right={<span className="muted mono text-[10px]">{data.features.length} indicators</span>}>
            <FeatureList items={data.features} dense />
          </Card>
        </>
      )}

      {!isLoading && !error && !data && (
        <Empty title="Pick a ticker above" hint="The model trains on 3 years of history and predicts the next 5 days." />
      )}
    </div>
  );
}

function ProbBar({ proba }: { proba: { skip: number; hold: number; watch: number } }) {
  const segs = [
    { key: "skip", v: proba.skip, color: "var(--red)" },
    { key: "hold", v: proba.hold, color: "var(--amber)" },
    { key: "watch", v: proba.watch, color: "var(--green)" },
  ];
  return (
    <div>
      <div className="flex h-3 rounded-sm overflow-hidden border border-[var(--border)]">
        {segs.map((s) => (
          <div
            key={s.key}
            style={{ width: `${Math.max(0, s.v * 100)}%`, backgroundColor: s.color }}
            title={`${s.key} ${(s.v * 100).toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="flex justify-between mt-1.5 text-[10px] mono uppercase tracking-widest">
        {segs.map((s) => (
          <span key={s.key} style={{ color: s.color }}>
            {s.key} {(s.v * 100).toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

function FeatureList({ items, dense = false }: { items: Explain["features"]; dense?: boolean }) {
  return (
    <ul className="space-y-1.5">
      {items.map((f) => (
        <li
          key={f.name}
          className={`flex items-center gap-3 ${dense ? "py-1" : "py-1.5"} border-b border-[var(--border)] last:border-b-0`}
        >
          <span style={{ color: directionColor(f.direction) }} aria-hidden>
            {directionIcon(f.direction)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] font-medium truncate">{f.label}</span>
              <span className="text-[11px] mono muted shrink-0">{f.note}</span>
            </div>
          </div>
          <div className="w-20 shrink-0">
            <div className="h-1.5 bg-[var(--bg)] border border-[var(--border)] rounded-sm overflow-hidden">
              <div
                style={{
                  width: `${Math.round(f.weight * 100)}%`,
                  backgroundColor: directionColor(f.direction),
                }}
                className="h-full"
              />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
