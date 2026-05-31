"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import BacktestChart, { DrawdownPane } from "@/components/BacktestChart";
import {
  Card,
  Stat,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  fmtPct,
  fmtPctSigned,
} from "@/components/ui";
import { swrFetcher, type Backtest } from "@/lib/api";
import {
  ChartLine,
  Lightning,
  ArrowsLeftRight,
  Trophy,
  Waveform,
  ArrowUpRight,
  ArrowDownRight,
} from "@phosphor-icons/react/dist/ssr";

const SAMPLES: { ticker: string; label: string; hint: string }[] = [
  { ticker: "SPY", label: "S&P 500", hint: "Broad US equity benchmark" },
  { ticker: "QQQ", label: "Nasdaq 100", hint: "Tech-heavy growth index" },
  { ticker: "AAPL", label: "Apple", hint: "Mega-cap with trend regimes" },
  { ticker: "NVDA", label: "Nvidia", hint: "High-vol momentum name" },
  { ticker: "TLT", label: "20Y Treasuries", hint: "Duration sensitivity" },
  { ticker: "BTC-USD", label: "Bitcoin", hint: "24/7 crypto, high vol" },
];

export default function Page() {
  return (
    <AuthGate>
      <BacktestPage />
    </AuthGate>
  );
}

function BacktestPage() {
  const [ticker, setTicker] = useState("SPY");
  const [submitted, setSubmitted] = useState("SPY");

  const key = submitted ? `/backtest/${encodeURIComponent(submitted)}` : null;
  const { data, error, isLoading, mutate } = useSWR<Backtest>(
    key,
    swrFetcher,
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    }
  );

  const stratLast = data?.equity_curve?.[data.equity_curve.length - 1];
  const stratFirst = data?.equity_curve?.[0];
  const stratTotal =
    stratFirst && stratLast ? stratLast / stratFirst - 1 : 0;
  const bhLast =
    data?.buy_hold_curve?.[(data.buy_hold_curve?.length ?? 0) - 1];
  const bhFirst = data?.buy_hold_curve?.[0];
  const bhTotal = bhFirst && bhLast ? bhLast / bhFirst - 1 : 0;
  const alpha = stratTotal - bhTotal;

  const trades = data?.trades ?? [];
  const winners = trades.filter((t) => t.return_pct > 0).length;
  const losers = trades.filter((t) => t.return_pct < 0).length;
  const avgWin = useMemo(() => {
    const wins = trades.filter((t) => t.return_pct > 0);
    if (!wins.length) return 0;
    return wins.reduce((a, b) => a + b.return_pct, 0) / wins.length;
  }, [trades]);
  const avgLoss = useMemo(() => {
    const ls = trades.filter((t) => t.return_pct < 0);
    if (!ls.length) return 0;
    return ls.reduce((a, b) => a + b.return_pct, 0) / ls.length;
  }, [trades]);

  function submit(t: string) {
    const clean = t.toUpperCase().trim();
    if (!clean || clean.length > 12) return;
    setTicker(clean);
    setSubmitted(clean);
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      {/* Hero */}
      <Card
        title={
          <span className="flex items-center gap-2">
            <ChartLine weight="duotone" size={16} />
            Walk-forward backtest
          </span>
        }
        right={
          data ? (
            <Badge tone={stratTotal >= bhTotal ? "up" : "down"}>
              {alpha >= 0 ? "+" : ""}
              {fmtPct(alpha)} vs buy & hold
            </Badge>
          ) : null
        }
      >
        <p className="text-[12px] leading-relaxed text-[var(--fg-muted)] max-w-3xl">
          Train a watch/hold/skip classifier on a rolling 252-day window, step
          forward 21 bars, take long positions when the model is confident.
          No look-ahead. Costs and slippage applied. Pick a sample below or type
          a ticker to run a real backtest against 3 years of daily bars.
        </p>
      </Card>

      {/* Sample selector + run */}
      <Card title="Try a sample">
        <div className="flex flex-wrap gap-2">
          {SAMPLES.map((s) => (
            <button
              key={s.ticker}
              onClick={() => submit(s.ticker)}
              aria-pressed={submitted === s.ticker}
              className={`text-left px-3 py-2 rounded-sm border transition-colors min-w-[160px] focus:outline-none focus:ring-1 focus:ring-[var(--amber)] ${
                submitted === s.ticker
                  ? "bg-[var(--amber)]/15 border-[var(--amber)]/50"
                  : "bg-[var(--bg-elev)] border-[var(--border)] hover:border-[var(--border-strong)]"
              }`}
            >
              <div className="mono text-[11px] font-semibold">{s.ticker}</div>
              <div className="text-[11px]">{s.label}</div>
              <div className="text-[10px] text-[var(--fg-muted)] mt-0.5">
                {s.hint}
              </div>
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit(ticker);
          }}
        >
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
          <Button type="submit" variant="primary">
            <Lightning weight="duotone" size={12} className="mr-1" /> Run backtest
          </Button>
          {data && (
            <Button type="button" variant="ghost" onClick={() => mutate()}>
              Refresh
            </Button>
          )}
        </form>
      </Card>

      {/* Stats */}
      {data && !isLoading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
            <Stat
              label="Strategy CAGR"
              value={fmtPctSigned(data.cagr)}
              tone={data.cagr >= 0 ? "up" : "down"}
            />
            <Stat
              label="Benchmark CAGR"
              value={fmtPctSigned(data.benchmark_cagr ?? null)}
              tone={(data.benchmark_cagr ?? 0) >= 0 ? "up" : "down"}
              delta="buy & hold"
            />
            <Stat label="Sharpe" value={data.sharpe.toFixed(2)} />
            <Stat label="Sortino" value={data.sortino.toFixed(2)} />
            <Stat
              label="Max drawdown"
              value={fmtPct(data.max_drawdown)}
              tone="down"
            />
            <Stat
              label="Exposure"
              value={fmtPct(data.exposure ?? 0)}
              delta="time in market"
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="Trades" value={String(data.n_trades)} />
            <Stat
              label="Hit rate"
              value={fmtPct(data.hit_rate)}
              tone={data.hit_rate >= 0.5 ? "up" : "neutral"}
            />
            <Stat
              label="Avg win"
              value={fmtPctSigned(avgWin)}
              tone="up"
            />
            <Stat
              label="Avg loss"
              value={fmtPctSigned(avgLoss)}
              tone="down"
            />
          </div>
        </>
      )}

      {/* Equity vs benchmark */}
      <Card
        title={
          <span className="flex items-center gap-2">
            <Waveform weight="duotone" size={16} />
            {data?.ticker ?? submitted} · equity vs buy & hold
          </span>
        }
        right={
          data ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: stratTotal >= 0 ? "#22C55E" : "#EF4444" }}
                />
                strategy
              </span>
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: "#6C7388" }}
                />
                buy & hold
              </span>
            </div>
          ) : null
        }
      >
        {isLoading && <Loading label="Running walk-forward" />}
        {error && <ErrorBox err={error} />}
        {!isLoading && !error && data && data.dates.length > 0 && (
          <BacktestChart
            dates={data.dates}
            strategy={data.equity_curve}
            benchmark={data.buy_hold_curve ?? null}
            position={data.position ?? null}
          />
        )}
        {!isLoading && !error && data && data.dates.length === 0 && (
          <Empty title="No bars" hint="Try a different ticker" />
        )}
      </Card>

      {/* Drawdown */}
      {data && !isLoading && data.drawdown_curve && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <ArrowDownRight weight="duotone" size={16} />
              Strategy drawdown
            </span>
          }
          right={
            <span className="mono text-[10px] text-[var(--fg-muted)]">
              worst {fmtPct(data.max_drawdown)}
            </span>
          }
        >
          <DrawdownPane
            dates={data.dates}
            drawdown={data.drawdown_curve}
          />
        </Card>
      )}

      {/* Trades */}
      {data && !isLoading && trades.length > 0 && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <ArrowsLeftRight weight="duotone" size={16} />
              Trades
            </span>
          }
          right={
            <span className="mono text-[10px] text-[var(--fg-muted)]">
              {winners} wins / {losers} losses
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] mono">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-[var(--fg-muted)] border-b border-[var(--border)]">
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">Entry</th>
                  <th className="py-2 pr-3">Exit</th>
                  <th className="py-2 pr-3 text-right">Bars</th>
                  <th className="py-2 pr-3 text-right">Return</th>
                </tr>
              </thead>
              <tbody>
                {trades
                  .slice()
                  .reverse()
                  .slice(0, 50)
                  .map((t, i) => {
                    const idx = trades.length - i;
                    const up = t.return_pct >= 0;
                    return (
                      <tr
                        key={`${t.entry_date}-${t.exit_date}`}
                        className="border-b border-[var(--border)]/60 hover:bg-[var(--bg-elev)]/40"
                      >
                        <td className="py-1.5 pr-3 text-[var(--fg-muted)]">
                          {idx}
                        </td>
                        <td className="py-1.5 pr-3">{t.entry_date}</td>
                        <td className="py-1.5 pr-3">{t.exit_date}</td>
                        <td className="py-1.5 pr-3 text-right">{t.bars}</td>
                        <td
                          className="py-1.5 pr-3 text-right"
                          style={{ color: up ? "#22C55E" : "#EF4444" }}
                        >
                          {up ? (
                            <ArrowUpRight
                              weight="duotone"
                              size={11}
                              className="inline mr-0.5"
                            />
                          ) : (
                            <ArrowDownRight
                              weight="duotone"
                              size={11}
                              className="inline mr-0.5"
                            />
                          )}
                          {fmtPctSigned(t.return_pct)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            {trades.length > 50 && (
              <p className="text-[10px] text-[var(--fg-muted)] mt-2">
                Showing 50 most recent of {trades.length} trades.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Alpha summary */}
      {data && !isLoading && (
        <Card
          title={
            <span className="flex items-center gap-2">
              <Trophy weight="duotone" size={16} />
              Versus buy & hold
            </span>
          }
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[12px]">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                Strategy total return
              </div>
              <div
                className="mono text-lg"
                style={{ color: stratTotal >= 0 ? "#22C55E" : "#EF4444" }}
              >
                {fmtPctSigned(stratTotal)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                Buy & hold total return
              </div>
              <div
                className="mono text-lg"
                style={{ color: bhTotal >= 0 ? "#22C55E" : "#EF4444" }}
              >
                {fmtPctSigned(bhTotal)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[var(--fg-muted)]">
                Alpha
              </div>
              <div
                className="mono text-lg"
                style={{ color: alpha >= 0 ? "#22C55E" : "#EF4444" }}
              >
                {fmtPctSigned(alpha)}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-[var(--fg-muted)] mt-3">
            Walk-forward means each prediction uses only data available before
            that bar. Costs are applied per turnover. Past performance does not
            guarantee future returns.
          </p>
        </Card>
      )}
    </div>
  );
}
