"use client";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import DrawdownChart from "@/components/DrawdownChart";
import { Card, Stat, Empty, Loading, ErrorBox, Badge, fmtPct, fmtUsd } from "@/components/ui";
import { swrFetcher, type PortfolioSnapshot, type Attribution, type DrawdownReport } from "@/lib/api";
import { ChartLineUp, TrendDown, Coins, Target } from "@phosphor-icons/react/dist/ssr";

export default function PortfolioPage() {
  return (
    <AuthGate>
      <Portfolio />
    </AuthGate>
  );
}

function Portfolio() {
  const snap = useSWR<PortfolioSnapshot>("/portfolio/snapshot", swrFetcher, { refreshInterval: 30000 });
  const attr = useSWR<Attribution>("/portfolio/attribution?benchmark=SPY&window=60", swrFetcher);
  const dd = useSWR<DrawdownReport>("/portfolio/drawdown", swrFetcher);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">Portfolio</h1>
          <p className="muted text-xs">Live snapshot of positions, attribution, and drawdown.</p>
        </div>
        {snap.data && (
          <div className="flex items-center gap-2">
            <Badge tone={dd.data?.state.tripped ? "down" : "up"}>
              {dd.data?.state.tripped ? "circuit tripped" : "circuit armed"}
            </Badge>
          </div>
        )}
      </header>

      <PnlRow snap={snap.data} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Drawdown vs peak" className="lg:col-span-2">
          {dd.error ? <ErrorBox err={dd.error} /> : !dd.data ? <Loading /> :
            dd.data.equity_curve.length < 2 ? (
              <Empty title="No equity history yet" hint="Log trades and snapshots to populate the curve." />
            ) : (
              <DrawdownChartWrap data={dd.data} />
            )}
        </Card>
        <Card title="Drawdown state">
          {dd.error ? <ErrorBox err={dd.error} /> : !dd.data ? <Loading /> : (
            <div className="space-y-2 text-sm">
              <Row k="As of" v={dd.data.state.as_of} />
              <Row k="Equity" v={fmtUsd(dd.data.state.equity)} />
              <Row k="Peak" v={fmtUsd(dd.data.state.peak)} />
              <Row k="Peak date" v={dd.data.state.peak_date} />
              <Row k="Drawdown" v={<span className="down">{fmtPct(dd.data.state.drawdown)}</span>} />
              <Row k="Trigger" v={fmtPct(dd.data.config.trigger)} />
              <Row k="Rearm" v={fmtPct(dd.data.config.rearm)} />
              <Row k="Reason" v={<span className="muted">{dd.data.state.reason || "n/a"}</span>} />
            </div>
          )}
        </Card>
      </div>

      <Card title="Attribution vs SPY (60d)">
        {attr.error ? <ErrorBox err={attr.error} /> : !attr.data ? <Loading /> : (
          <AttrPanel a={attr.data} />
        )}
      </Card>

      <Card title="Positions">
        {snap.error ? <ErrorBox err={snap.error} /> : !snap.data ? <Loading /> :
          snap.data.positions.length === 0 ? (
            <Empty title="No open positions" hint="POST /portfolio/trades to start tracking." />
          ) : <PositionsTable snap={snap.data} />}
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
  return <DrawdownChart data={series} trigger={-Math.abs(data.config.trigger)} />;
}

function PnlRow({ snap }: { snap: PortfolioSnapshot | undefined }) {
  if (!snap) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => <div key={i} className="panel p-4 h-20 animate-pulse" />)}
      </div>
    );
  }
  const totalPnl = snap.total_unrealized + snap.total_realized;
  const ret = snap.total_cost > 0 ? totalPnl / snap.total_cost : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Stat
        label="Market value"
        value={fmtUsd(snap.total_market_value)}
        delta={<span><Coins weight="duotone" className="inline mr-1" />{snap.positions.length} positions</span>}
      />
      <Stat
        label="Cost basis"
        value={fmtUsd(snap.total_cost)}
      />
      <Stat
        label="Unrealized P&L"
        tone={snap.total_unrealized >= 0 ? "up" : "down"}
        value={fmtUsd(snap.total_unrealized)}
        delta={<><ChartLineUp weight="duotone" className="inline mr-1" />{fmtPct(snap.total_cost > 0 ? snap.total_unrealized / snap.total_cost : 0)}</>}
      />
      <Stat
        label="Total return"
        tone={totalPnl >= 0 ? "up" : "down"}
        value={fmtPct(ret)}
        delta={<><Target weight="duotone" className="inline mr-1" />realized {fmtUsd(snap.total_realized)}</>}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] pb-1.5">
      <span className="muted text-xs">{k}</span>
      <span className="num text-sm">{v}</span>
    </div>
  );
}

function PositionsTable({ snap }: { snap: PortfolioSnapshot }) {
  const rows = [...snap.positions].sort((a, b) => b.market_value - a.market_value);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left muted text-xs uppercase tracking-wide border-b border-[var(--border)]">
            <th className="py-2 pr-3">Ticker</th>
            <th className="text-right pr-3">Qty</th>
            <th className="text-right pr-3">Avg</th>
            <th className="text-right pr-3">Last</th>
            <th className="text-right pr-3">Mkt Value</th>
            <th className="text-right pr-3">Weight</th>
            <th className="text-right pr-3">Unrealized</th>
            <th className="text-right pr-3">%</th>
            <th className="text-right">Realized</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const w = snap.weights[p.ticker] ?? (snap.total_market_value > 0 ? p.market_value / snap.total_market_value : 0);
            return (
              <tr key={p.ticker} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                <td className="py-2 pr-3 mono">{p.ticker}</td>
                <td className="num text-right pr-3">{p.quantity}</td>
                <td className="num text-right pr-3">{fmtUsd(p.avg_cost)}</td>
                <td className="num text-right pr-3">{p.last_price == null ? "n/a" : fmtUsd(p.last_price)}</td>
                <td className="num text-right pr-3">{fmtUsd(p.market_value)}</td>
                <td className="num text-right pr-3">{fmtPct(w)}</td>
                <td className={`num text-right pr-3 ${p.unrealized_pnl >= 0 ? "up" : "down"}`}>{fmtUsd(p.unrealized_pnl)}</td>
                <td className={`num text-right pr-3 ${p.unrealized_pct >= 0 ? "up" : "down"}`}>{fmtPct(p.unrealized_pct)}</td>
                <td className={`num text-right ${p.realized_pnl >= 0 ? "up" : "down"}`}>{fmtUsd(p.realized_pnl)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AttrPanel({ a }: { a: Attribution }) {
  const top = [...a.contributions].sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution)).slice(0, 12);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="space-y-2 text-sm">
        <Row k="Portfolio return" v={<span className={a.portfolio_return >= 0 ? "up" : "down"}>{fmtPct(a.portfolio_return)}</span>} />
        <Row k="Benchmark return" v={<span className={a.benchmark_return >= 0 ? "up" : "down"}>{fmtPct(a.benchmark_return)}</span>} />
        <Row k="Excess" v={<span className={a.excess_return >= 0 ? "up" : "down"}>{fmtPct(a.excess_return)}</span>} />
        <Row k="Alpha (ann.)" v={fmtPct(a.alpha_annualized)} />
        <Row k="Beta" v={a.beta.toFixed(3)} />
        <Row k="Tracking error" v={fmtPct(a.tracking_error_annualized)} />
        <Row k="Info ratio" v={a.information_ratio.toFixed(2)} />
        <Row k="R squared" v={a.r_squared.toFixed(2)} />
      </div>
      <div className="lg:col-span-2">
        <div className="muted text-xs mb-2">Top contributions ({a.window}d window)</div>
        {top.length === 0 ? (
          <Empty title="No contributions yet" hint="Need at least one trade with history." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                <th className="py-2">Ticker</th>
                <th className="text-right">Weight</th>
                <th className="text-right">Return</th>
                <th className="text-right">Contribution</th>
                <th>Bar</th>
              </tr>
            </thead>
            <tbody>
              {top.map((c) => {
                const max = Math.max(...top.map((t) => Math.abs(t.contribution))) || 1;
                const pct = Math.abs(c.contribution) / max;
                return (
                  <tr key={c.ticker} className="border-b border-[var(--border)]">
                    <td className="py-2 mono">{c.ticker}</td>
                    <td className="num text-right">{fmtPct(c.weight)}</td>
                    <td className={`num text-right ${c.period_return >= 0 ? "up" : "down"}`}>{fmtPct(c.period_return)}</td>
                    <td className={`num text-right ${c.contribution >= 0 ? "up" : "down"}`}>{fmtPct(c.contribution)}</td>
                    <td>
                      <div className="h-1.5 w-32 bg-[var(--border)] rounded overflow-hidden">
                        <div
                          className={c.contribution >= 0 ? "bg-[var(--green)] h-full" : "bg-[var(--red)] h-full"}
                          style={{ width: `${pct * 100}%` }}
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
