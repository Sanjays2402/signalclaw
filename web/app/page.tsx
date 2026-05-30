"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import Sparkline from "@/components/Sparkline";
import DrawdownGauge from "@/components/DrawdownGauge";
import {
  Card,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  fmtPct,
  fmtPctSigned,
  fmtUsd,
  fmtUsdSigned,
  colorOf,
} from "@/components/ui";
import {
  swrFetcher,
  type DailyReport,
  type Regime,
  type Pick,
  type PortfolioSnapshot,
  type DrawdownReport,
} from "@/lib/api";
import { ShieldCheck, CaretRight, ArrowUpRight, ArrowDownRight } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <Today />
    </AuthGate>
  );
}

// Seed equity curve when API empty.
function seedCurve(): number[] {
  const out: number[] = [];
  let v = 100000;
  let seed = 1;
  for (let i = 0; i < 60; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const r = (seed / 233280 - 0.48) * 0.02;
    v = Math.max(50000, v * (1 + r));
    out.push(v);
  }
  return out;
}

function Today() {
  const [guarded, setGuarded] = useState(false);
  const picksKey = guarded ? "/picks/guarded" : "/picks";
  const picks = useSWR<DailyReport>(picksKey, swrFetcher, { refreshInterval: 60000 });
  const reg = useSWR<Regime>("/regime?ticker=SPY", swrFetcher, { refreshInterval: 60000 });
  const snap = useSWR<PortfolioSnapshot>("/portfolio/snapshot", swrFetcher, {
    refreshInterval: 30000,
    shouldRetryOnError: false,
  });
  const dd = useSWR<DrawdownReport>("/portfolio/drawdown", swrFetcher, {
    shouldRetryOnError: false,
  });

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <Hero snap={snap.data} dd={dd.data} reg={reg.data} />

      <Card
        title="Signals · today"
        right={
          <div className="flex items-center gap-3">
            <span className="muted text-[10px] uppercase tracking-widest mono">
              {picks.data?.as_of ?? "--"}
            </span>
            <button
              onClick={() => setGuarded((g) => !g)}
              className={`text-[10px] px-2 py-1 rounded-sm border flex items-center gap-1.5 uppercase tracking-widest font-semibold mono ${
                guarded
                  ? "bg-[var(--amber)]/15 text-[var(--amber)] border-[var(--amber)]/40"
                  : "border-[var(--border-strong)] muted hover:text-white"
              }`}
              aria-pressed={guarded}
              title="Filter picks through portfolio drawdown guard"
            >
              <ShieldCheck weight="duotone" size={12} />
              Guard {guarded ? "on" : "off"}
            </button>
          </div>
        }
      >
        {picks.error ? (
          <ErrorBox err={picks.error} />
        ) : !picks.data ? (
          <Loading label="Fetching picks" />
        ) : picks.data.picks.length === 0 ? (
          <Empty
            title={guarded ? "Guard suppressing all signals" : "No picks"}
            hint={
              guarded
                ? "Drawdown breach active. Toggle guard off to see raw picks."
                : "Watchlist empty or pipeline not run yet."
            }
          />
        ) : (
          <PicksTable picks={picks.data.picks} riskScale={reg.data?.risk_scale ?? 1} />
        )}
      </Card>
    </div>
  );
}

function Hero({
  snap,
  dd,
  reg,
}: {
  snap?: PortfolioSnapshot;
  dd?: DrawdownReport;
  reg?: Regime;
}) {
  const totalPnl = snap ? snap.total_unrealized + snap.total_realized : null;
  const ret = snap && snap.total_cost > 0 ? totalPnl! / snap.total_cost : null;
  const tone = colorOf(totalPnl);

  // Build equity sparkline from drawdown report, fall back to seed.
  let curveVals: number[] = seedCurve();
  let isSeed = true;
  if (dd?.equity_curve && dd.equity_curve.length >= 2) {
    curveVals = dd.equity_curve.map((r: any) => r.equity ?? r.value ?? 0);
    isSeed = false;
  }
  const sparkColor = curveVals[curveVals.length - 1] >= curveVals[0] ? "#22C55E" : "#EF4444";

  const ddVal = dd?.state?.drawdown ?? 0;
  const ddTrigger = dd?.config?.trigger ?? 0.1;
  const tripped = dd?.state?.tripped ?? false;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
      {/* Big P&L number */}
      <div className="panel lg:col-span-7 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="muted text-[10px] uppercase tracking-widest">Unrealized + realized</div>
          {snap && (
            <div className="muted text-[10px] uppercase tracking-widest mono">
              {snap.positions.length} pos · book {fmtUsd(snap.total_cost, 0)}
            </div>
          )}
        </div>
        <div className="flex items-end gap-4 flex-wrap">
          {totalPnl == null ? (
            <div className="pnl-hero muted">$--,---</div>
          ) : (
            <div className={`pnl-hero ${tone}`}>
              {totalPnl >= 0 ? "+" : "-"}$
              {Math.abs(totalPnl).toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
          )}
          {ret != null && (
            <div className={`mono text-xl font-semibold ${tone}`}>{fmtPctSigned(ret)}</div>
          )}
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <Sparkline data={curveVals} width={420} height={48} color={sparkColor} fill />
            <div className="muted text-[10px] uppercase tracking-widest mt-1 mono">
              Equity · {curveVals.length}d {isSeed && <span className="warn">(seed)</span>}
            </div>
          </div>
          {snap && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] mono">
              <span className="muted">Mkt val</span>
              <span className="text-right">{fmtUsd(snap.total_market_value, 0)}</span>
              <span className="muted">Unrealized</span>
              <span className={`text-right ${colorOf(snap.total_unrealized)}`}>
                {fmtUsdSigned(snap.total_unrealized, 0)}
              </span>
              <span className="muted">Realized</span>
              <span className={`text-right ${colorOf(snap.total_realized)}`}>
                {fmtUsdSigned(snap.total_realized, 0)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Drawdown gauge */}
      <div className="panel lg:col-span-3 p-4 flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <div className="muted text-[10px] uppercase tracking-widest">Drawdown</div>
          {dd && (
            <Badge tone={tripped ? "down" : "up"}>{tripped ? "Tripped" : "Armed"}</Badge>
          )}
        </div>
        <DrawdownGauge value={ddVal} trigger={ddTrigger} />
        {dd && (
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mono">
            <span className="muted">Peak</span>
            <span className="text-right">{fmtUsd(dd.state.peak, 0)}</span>
            <span className="muted">Equity</span>
            <span className="text-right">{fmtUsd(dd.state.equity, 0)}</span>
            <span className="muted">Trigger</span>
            <span className="text-right warn">{fmtPct(dd.config.trigger)}</span>
          </div>
        )}
      </div>

      {/* Regime panel */}
      <div className="panel lg:col-span-2 p-4 flex flex-col gap-2">
        <div className="muted text-[10px] uppercase tracking-widest">Regime · SPY</div>
        {!reg ? (
          <div className="muted text-xs mono">--</div>
        ) : (
          <>
            <RegStat label="Vol" value={fmtPct(reg.realized_vol)} />
            <RegStat
              label="Trend"
              value={`${(reg.trend_slope * 1e4).toFixed(1)} bps/d`}
              tone={colorOf(reg.trend_slope)}
            />
            <RegStat label="DD" value={fmtPct(reg.drawdown)} tone={colorOf(reg.drawdown)} />
            <RegStat label="Risk" value={`${reg.risk_scale.toFixed(2)}x`} />
            <RegStat label="Conf" value={fmtPct(reg.confidence)} />
          </>
        )}
      </div>
    </div>
  );
}

function RegStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="muted uppercase tracking-widest">{label}</span>
      <span className={`mono ${tone ?? ""}`}>{value}</span>
    </div>
  );
}

function labelTone(l: string): "up" | "down" | "warn" | "info" | "neutral" {
  if (l === "watch") return "info";
  if (l === "skip") return "down";
  if (l === "hold") return "warn";
  if (l === "buy" || l === "long") return "up";
  if (l === "sell" || l === "short") return "down";
  return "neutral";
}

function PicksTable({ picks, riskScale }: { picks: Pick[]; riskScale: number }) {
  return (
    <div className="overflow-x-auto -mx-3">
      <table className="trade">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Label</th>
            <th className="r">Score</th>
            <th className="r">Exp 5d</th>
            <th className="r">Regime adj</th>
            <th>Rationale</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((p) => {
            const adj = p.expected_return * riskScale;
            return (
              <tr key={p.ticker}>
                <td>
                  <Link
                    href={`/ticker/${p.ticker}`}
                    className="mono font-semibold hover:text-[var(--amber)] inline-flex items-center gap-1"
                  >
                    {p.ticker}
                    <CaretRight weight="bold" size={10} className="muted" />
                  </Link>
                </td>
                <td>
                  <Badge tone={labelTone(p.label)}>{p.label}</Badge>
                </td>
                <td className="r mono">{p.score.toFixed(2)}</td>
                <td className={`r mono ${colorOf(p.expected_return)}`}>
                  {p.expected_return >= 0 ? (
                    <ArrowUpRight weight="bold" size={10} className="inline mr-0.5" />
                  ) : (
                    <ArrowDownRight weight="bold" size={10} className="inline mr-0.5" />
                  )}
                  {fmtPctSigned(p.expected_return)}
                </td>
                <td className={`r mono ${colorOf(adj)}`}>{fmtPctSigned(adj)}</td>
                <td className="muted" style={{ maxWidth: 360, whiteSpace: "normal", fontSize: 11 }}>
                  {p.rationale}
                </td>
                <td>
                  {p.risk_flags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {p.risk_flags.map((f) => (
                        <Badge key={f} tone="warn">
                          {f}
                        </Badge>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
