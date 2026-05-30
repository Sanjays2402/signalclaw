"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import DrawdownChart from "@/components/DrawdownChart";
import EquityChart from "@/components/EquityChart";
import {
  Card,
  Stat,
  Empty,
  Loading,
  ErrorBox,
  Badge,
  fmtPct,
  fmtPctSigned,
  fmtUsd,
  fmtUsdSigned,
  colorOf,
} from "@/components/ui";
import {
  swrFetcher,
  type PortfolioSnapshot,
  type Attribution,
  type DrawdownReport,
  type Position,
} from "@/lib/api";
import { CaretUp, CaretDown } from "@phosphor-icons/react/dist/ssr";

export default function PortfolioPage() {
  return (
    <AuthGate>
      <Portfolio />
    </AuthGate>
  );
}

type SortKey = "ticker" | "qty" | "avg" | "mark" | "mv" | "weight" | "pnl" | "pct" | "realized";

function Portfolio() {
  const snap = useSWR<PortfolioSnapshot>("/portfolio/snapshot", swrFetcher, {
    refreshInterval: 30000,
  });
  const attr = useSWR<Attribution>("/portfolio/attribution?benchmark=SPY&window=60", swrFetcher);
  const dd = useSWR<DrawdownReport>("/portfolio/drawdown", swrFetcher);

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <PnlRow snap={snap.data} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <Card title="Equity curve" className="lg:col-span-7">
          {dd.error ? (
            <ErrorBox err={dd.error} />
          ) : !dd.data ? (
            <Loading />
          ) : dd.data.equity_curve.length < 2 ? (
            <Empty title="No equity history" hint="Log trades and snapshots to populate." />
          ) : (
            <EquityChart
              dates={dd.data.equity_curve.map((r) => r.date)}
              values={dd.data.equity_curve.map((r) => r.equity)}
              height={260}
            />
          )}
        </Card>
        <Card title="Drawdown vs peak" className="lg:col-span-5">
          {dd.error ? (
            <ErrorBox err={dd.error} />
          ) : !dd.data ? (
            <Loading />
          ) : dd.data.equity_curve.length < 2 ? (
            <Empty title="No equity history" />
          ) : (
            <DrawdownChartWrap data={dd.data} />
          )}
        </Card>
      </div>

      <Card title="Attribution vs SPY · 60d">
        {attr.error ? <ErrorBox err={attr.error} /> : !attr.data ? <Loading /> : <AttrPanel a={attr.data} />}
      </Card>

      <Card
        title="Positions"
        right={
          snap.data && (
            <span className="muted text-[10px] uppercase tracking-widest mono">
              {snap.data.positions.length} rows
            </span>
          )
        }
      >
        {snap.error ? (
          <ErrorBox err={snap.error} />
        ) : !snap.data ? (
          <Loading />
        ) : snap.data.positions.length === 0 ? (
          <Empty title="No open positions" hint="POST /portfolio/trades to start tracking." />
        ) : (
          <PositionsTable snap={snap.data} />
        )}
      </Card>
    </div>
  );
}

function DrawdownChartWrap({ data }: { data: DrawdownReport }) {
  const series = data.equity_curve.map((row: any) => {
    const eq = row.equity ?? row.value ?? 0;
    return { date: row.date, equity: eq, drawdown: 0 };
  });
  let peak = -Infinity;
  for (const r of series) {
    peak = Math.max(peak, r.equity);
    r.drawdown = peak > 0 ? r.equity / peak - 1 : 0;
  }
  return <DrawdownChart data={series} trigger={-Math.abs(data.config.trigger)} height={260} />;
}

function PnlRow({ snap }: { snap: PortfolioSnapshot | undefined }) {
  if (!snap) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="panel p-4 h-20 animate-pulse" />
        ))}
      </div>
    );
  }
  const totalPnl = snap.total_unrealized + snap.total_realized;
  const ret = snap.total_cost > 0 ? totalPnl / snap.total_cost : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Stat label="Mkt value" value={fmtUsd(snap.total_market_value, 0)} delta={`${snap.positions.length} pos`} />
      <Stat label="Cost basis" value={fmtUsd(snap.total_cost, 0)} />
      <Stat
        label="Unrealized"
        tone={colorOf(snap.total_unrealized) as any}
        value={fmtUsdSigned(snap.total_unrealized, 0)}
        delta={fmtPctSigned(snap.total_cost > 0 ? snap.total_unrealized / snap.total_cost : 0)}
      />
      <Stat
        label="Realized"
        tone={colorOf(snap.total_realized) as any}
        value={fmtUsdSigned(snap.total_realized, 0)}
      />
      <Stat
        label="Total return"
        tone={colorOf(totalPnl) as any}
        value={fmtPctSigned(ret)}
        delta={fmtUsdSigned(totalPnl, 0)}
      />
    </div>
  );
}

function Th({
  k,
  sort,
  setSort,
  children,
  align = "left",
}: {
  k: SortKey;
  sort: { k: SortKey; dir: 1 | -1 };
  setSort: (s: { k: SortKey; dir: 1 | -1 }) => void;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  const active = sort.k === k;
  return (
    <th
      className={align === "right" ? "r" : ""}
      style={{ cursor: "pointer", color: active ? "var(--amber)" : undefined }}
      onClick={() => setSort({ k, dir: active ? ((sort.dir * -1) as 1 | -1) : -1 })}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active &&
          (sort.dir === -1 ? (
            <CaretDown weight="bold" size={9} />
          ) : (
            <CaretUp weight="bold" size={9} />
          ))}
      </span>
    </th>
  );
}

function PositionsTable({ snap }: { snap: PortfolioSnapshot }) {
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: "mv", dir: -1 });

  const rows = useMemo(() => {
    const cmp = (a: Position, b: Position) => {
      const wA = snap.weights[a.ticker] ?? (snap.total_market_value > 0 ? a.market_value / snap.total_market_value : 0);
      const wB = snap.weights[b.ticker] ?? (snap.total_market_value > 0 ? b.market_value / snap.total_market_value : 0);
      const get = (p: Position, w: number): number | string => {
        switch (sort.k) {
          case "ticker": return p.ticker;
          case "qty": return p.quantity;
          case "avg": return p.avg_cost;
          case "mark": return p.last_price ?? 0;
          case "mv": return p.market_value;
          case "weight": return w;
          case "pnl": return p.unrealized_pnl;
          case "pct": return p.unrealized_pct;
          case "realized": return p.realized_pnl;
        }
      };
      const av = get(a, wA), bv = get(b, wB);
      if (typeof av === "string" && typeof bv === "string") return sort.dir * av.localeCompare(bv);
      return sort.dir * ((av as number) - (bv as number));
    };
    return [...snap.positions].sort(cmp);
  }, [snap, sort]);

  return (
    <div className="overflow-x-auto -mx-3">
      <table className="trade">
        <thead>
          <tr>
            <Th k="ticker" sort={sort} setSort={setSort}>Ticker</Th>
            <Th k="qty" sort={sort} setSort={setSort} align="right">Qty</Th>
            <Th k="avg" sort={sort} setSort={setSort} align="right">Avg</Th>
            <Th k="mark" sort={sort} setSort={setSort} align="right">Mark</Th>
            <Th k="mv" sort={sort} setSort={setSort} align="right">Mkt val</Th>
            <Th k="weight" sort={sort} setSort={setSort} align="right">Weight</Th>
            <Th k="pnl" sort={sort} setSort={setSort} align="right">P&amp;L</Th>
            <Th k="pct" sort={sort} setSort={setSort} align="right">P&amp;L %</Th>
            <Th k="realized" sort={sort} setSort={setSort} align="right">Realized</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const w =
              snap.weights[p.ticker] ??
              (snap.total_market_value > 0 ? p.market_value / snap.total_market_value : 0);
            return (
              <tr key={p.ticker}>
                <td>
                  <Link href={`/ticker/${p.ticker}`} className="mono font-semibold hover:text-[var(--amber)]">
                    {p.ticker}
                  </Link>
                </td>
                <td className="r mono">{p.quantity}</td>
                <td className="r mono">{fmtUsd(p.avg_cost)}</td>
                <td className="r mono">{p.last_price == null ? "--" : fmtUsd(p.last_price)}</td>
                <td className="r mono">{fmtUsd(p.market_value)}</td>
                <td className="r mono muted">{fmtPct(w)}</td>
                <td className={`r mono ${colorOf(p.unrealized_pnl)}`}>{fmtUsdSigned(p.unrealized_pnl)}</td>
                <td className={`r mono ${colorOf(p.unrealized_pct)}`}>{fmtPctSigned(p.unrealized_pct)}</td>
                <td className={`r mono ${colorOf(p.realized_pnl)}`}>{fmtUsdSigned(p.realized_pnl)}</td>
              </tr>
            );
          })}
          {/* Totals row */}
          <tr style={{ background: "var(--panel-2)", borderTop: "1px solid var(--border-strong)" }}>
            <td className="mono font-semibold" style={{ color: "var(--amber)" }}>TOTAL</td>
            <td colSpan={3} />
            <td className="r mono font-semibold">{fmtUsd(snap.total_market_value, 0)}</td>
            <td className="r mono muted">100.00%</td>
            <td className={`r mono font-semibold ${colorOf(snap.total_unrealized)}`}>
              {fmtUsdSigned(snap.total_unrealized, 0)}
            </td>
            <td className={`r mono ${colorOf(snap.total_unrealized)}`}>
              {fmtPctSigned(snap.total_cost > 0 ? snap.total_unrealized / snap.total_cost : 0)}
            </td>
            <td className={`r mono font-semibold ${colorOf(snap.total_realized)}`}>
              {fmtUsdSigned(snap.total_realized, 0)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function AttrPanel({ a }: { a: Attribution }) {
  const top = [...a.contributions]
    .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution))
    .slice(0, 12);
  const max = Math.max(...top.map((t) => Math.abs(t.contribution)), 1e-9);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="space-y-1 text-[11px]">
        <Row k="Port return" v={fmtPctSigned(a.portfolio_return)} t={colorOf(a.portfolio_return)} />
        <Row k="Bench return" v={fmtPctSigned(a.benchmark_return)} t={colorOf(a.benchmark_return)} />
        <Row k="Excess" v={fmtPctSigned(a.excess_return)} t={colorOf(a.excess_return)} />
        <Row k="Alpha (ann.)" v={fmtPctSigned(a.alpha_annualized)} t={colorOf(a.alpha_annualized)} />
        <Row k="Beta" v={a.beta.toFixed(3)} />
        <Row k="Track err" v={fmtPct(a.tracking_error_annualized)} />
        <Row k="Info ratio" v={a.information_ratio.toFixed(2)} t={colorOf(a.information_ratio)} />
        <Row k="R²" v={a.r_squared.toFixed(2)} />
      </div>
      <div className="lg:col-span-2">
        <div className="muted text-[10px] uppercase tracking-widest mb-2">
          Top contributions · {a.window}d
        </div>
        {top.length === 0 ? (
          <Empty title="No contributions yet" />
        ) : (
          <table className="trade">
            <thead>
              <tr>
                <th>Ticker</th>
                <th className="r">Weight</th>
                <th className="r">Return</th>
                <th className="r">Contrib</th>
                <th style={{ width: 220 }}>Bar</th>
              </tr>
            </thead>
            <tbody>
              {top.map((c) => {
                const pct = Math.abs(c.contribution) / max;
                const pos = c.contribution >= 0;
                return (
                  <tr key={c.ticker}>
                    <td className="mono font-semibold">{c.ticker}</td>
                    <td className="r mono muted">{fmtPct(c.weight)}</td>
                    <td className={`r mono ${colorOf(c.period_return)}`}>{fmtPctSigned(c.period_return)}</td>
                    <td className={`r mono ${colorOf(c.contribution)}`}>{fmtPctSigned(c.contribution)}</td>
                    <td>
                      <div className="relative h-3 w-full" style={{ background: "var(--panel-2)" }}>
                        <div
                          className="absolute top-0 bottom-0"
                          style={{
                            left: "50%",
                            width: 1,
                            background: "var(--border-strong)",
                          }}
                        />
                        <div
                          className="absolute top-0 bottom-0"
                          style={{
                            left: pos ? "50%" : `${50 - pct * 50}%`,
                            width: `${pct * 50}%`,
                            background: pos ? "var(--green)" : "var(--red)",
                            opacity: 0.85,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, t }: { k: string; v: React.ReactNode; t?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] py-1">
      <span className="muted uppercase tracking-widest">{k}</span>
      <span className={`mono ${t ?? ""}`}>{v}</span>
    </div>
  );
}
