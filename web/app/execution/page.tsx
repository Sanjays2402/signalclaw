"use client";
import { useMemo, useState } from "react";
import AuthGate from "@/components/AuthGate";
import { Card, Stat, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd } from "@/components/ui";
import { api, ApiError, type ExecReport, type ExecBar } from "@/lib/api";
import { Lightning, Play, ArrowsClockwise } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <Sim />
    </AuthGate>
  );
}

type FormState = {
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  arrival_price: number;
  schedule: "twap" | "vwap" | "pov";
  n_bars: number;
  drift_bps: number;
  vol_bps: number;
  avg_volume: number;
  participation_rate: number;
  max_participation: number;
  base_slippage_bps: number;
  slippage_bps_per_pct_adv: number;
  commission_per_share: number;
};

const DEFAULTS: FormState = {
  ticker: "AAPL",
  side: "buy",
  shares: 10000,
  arrival_price: 200,
  schedule: "vwap",
  n_bars: 26,
  drift_bps: 5,
  vol_bps: 10,
  avg_volume: 200000,
  participation_rate: 0.1,
  max_participation: 0.2,
  base_slippage_bps: 1,
  slippage_bps_per_pct_adv: 5,
  commission_per_share: 0.005,
};

// Deterministic pseudo-random walk so reruns are reproducible.
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function synthBars(f: FormState): ExecBar[] {
  const rng = mulberry32(0xC0FFEE);
  const bars: ExecBar[] = [];
  let p = f.arrival_price;
  const drift = f.drift_bps / 1e4;
  const vol = f.vol_bps / 1e4;
  for (let i = 0; i < f.n_bars; i++) {
    // Box-Muller for normal noise
    const u1 = Math.max(rng(), 1e-9);
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    p = p * (1 + drift + vol * z);
    if (!Number.isFinite(p) || p <= 0) p = f.arrival_price;
    // Volume: U-curve (heavy at open and close)
    const x = (i + 0.5) / f.n_bars;
    const ucurve = 0.6 + 1.6 * (Math.pow(x - 0.5, 2) * 4);
    const v = Math.max(1, Math.round(f.avg_volume * ucurve * (0.85 + 0.3 * rng())));
    bars.push({ index: i, price: Math.round(p * 1e4) / 1e4, volume: v });
  }
  return bars;
}

function Sim() {
  const [f, setF] = useState<FormState>(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ExecReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bars, setBars] = useState<ExecBar[]>(() => synthBars(DEFAULTS));

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setF((s) => ({ ...s, [k]: v }));
  }

  function regenBars() {
    setBars(synthBars(f));
  }

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setRunning(true);
    setErr(null);
    setReport(null);
    try {
      const body = {
        order: {
          ticker: f.ticker.toUpperCase(),
          side: f.side,
          shares: f.shares,
          arrival_price: f.arrival_price,
          schedule: f.schedule,
          participation_rate: f.participation_rate,
          max_participation: f.max_participation,
          base_slippage_bps: f.base_slippage_bps,
          slippage_bps_per_pct_adv: f.slippage_bps_per_pct_adv,
          commission_per_share: f.commission_per_share,
        },
        bars,
      };
      const r = await api<ExecReport>("/execution/simulate", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setReport(r);
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status}: ${e.body || e.message}` : String(e);
      setErr(msg);
    } finally {
      setRunning(false);
    }
  }

  const totalVol = useMemo(() => bars.reduce((s, b) => s + b.volume, 0), [bars]);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Execution simulator</h1>
          <p className="muted text-xs">Estimate fill price, slippage, and commissions for TWAP, VWAP, or POV schedules.</p>
        </div>
      </header>

      <form onSubmit={run} className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Order">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ticker">
              <Input value={f.ticker} onChange={(e) => update("ticker", e.target.value)} required />
            </Field>
            <Field label="Side">
              <Select value={f.side} onChange={(e) => update("side", e.target.value as "buy" | "sell")}>
                <option value="buy">buy</option>
                <option value="sell">sell</option>
              </Select>
            </Field>
            <Field label="Shares">
              <Input type="number" min={1} value={f.shares} onChange={(e) => update("shares", Math.max(1, parseInt(e.target.value || "0", 10)))} />
            </Field>
            <Field label="Arrival price">
              <Input type="number" step="0.01" min={0.01} value={f.arrival_price} onChange={(e) => update("arrival_price", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Schedule">
              <Select value={f.schedule} onChange={(e) => update("schedule", e.target.value as FormState["schedule"])}>
                <option value="vwap">VWAP</option>
                <option value="twap">TWAP</option>
                <option value="pov">POV</option>
              </Select>
            </Field>
            <Field label="Participation rate (POV)">
              <Input type="number" step="0.01" min={0} max={1} value={f.participation_rate} onChange={(e) => update("participation_rate", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Max participation">
              <Input type="number" step="0.01" min={0} max={1} value={f.max_participation} onChange={(e) => update("max_participation", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Commission per share">
              <Input type="number" step="0.001" min={0} value={f.commission_per_share} onChange={(e) => update("commission_per_share", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Base slippage (bps)">
              <Input type="number" step="0.1" min={0} value={f.base_slippage_bps} onChange={(e) => update("base_slippage_bps", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Slippage per % ADV (bps)">
              <Input type="number" step="0.1" min={0} value={f.slippage_bps_per_pct_adv} onChange={(e) => update("slippage_bps_per_pct_adv", parseFloat(e.target.value || "0"))} />
            </Field>
          </div>
        </Card>

        <Card
          title="Market bars"
          right={
            <Button type="button" variant="ghost" onClick={regenBars} className="inline-flex items-center gap-1.5">
              <ArrowsClockwise weight="duotone" size={14} /> Regenerate
            </Button>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Number of bars">
              <Input type="number" min={2} max={400} value={f.n_bars} onChange={(e) => update("n_bars", Math.max(2, parseInt(e.target.value || "26", 10)))} />
            </Field>
            <Field label="Avg volume per bar">
              <Input type="number" min={1} value={f.avg_volume} onChange={(e) => update("avg_volume", Math.max(1, parseInt(e.target.value || "1", 10)))} />
            </Field>
            <Field label="Drift per bar (bps)">
              <Input type="number" step="0.1" value={f.drift_bps} onChange={(e) => update("drift_bps", parseFloat(e.target.value || "0"))} />
            </Field>
            <Field label="Vol per bar (bps)">
              <Input type="number" step="0.1" min={0} value={f.vol_bps} onChange={(e) => update("vol_bps", parseFloat(e.target.value || "0"))} />
            </Field>
          </div>
          <div className="muted text-xs mt-3">
            {bars.length} bars, total volume {totalVol.toLocaleString()}, last price {bars[bars.length - 1]?.price.toFixed(2)}
          </div>
        </Card>

        <div className="lg:col-span-2 flex justify-end">
          <Button type="submit" disabled={running} className="inline-flex items-center gap-1.5">
            {running ? <ArrowsClockwise weight="duotone" size={14} className="animate-spin" /> : <Play weight="duotone" size={14} />}
            {running ? "Simulating" : "Simulate"}
          </Button>
        </div>
      </form>

      {err && <ErrorBox err={err} />}
      {running && !report && <Loading label="Running schedule" />}
      {report && <Result r={report} />}
      {!err && !running && !report && (
        <Empty title="No simulation run yet" hint="Fill in the order and press Simulate." />
      )}
    </div>
  );
}

function Result({ r }: { r: ExecReport }) {
  const slipTone: "up" | "down" | "neutral" =
    r.slippage_vs_arrival_bps > 5 ? "down" : r.slippage_vs_arrival_bps < -5 ? "up" : "neutral";
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="filled" value={`${r.filled_shares.toLocaleString()} / ${r.requested_shares.toLocaleString()}`} />
        <Stat label="avg fill" value={`$${r.avg_fill_price.toFixed(4)}`} />
        <Stat label="interval vwap" value={`$${r.interval_vwap.toFixed(4)}`} />
        <Stat label="notional" value={fmtUsd(r.notional)} />
        <Stat label="commission" value={fmtUsd(r.commission_total)} />
        <Stat label="slip vs arrival" value={`${r.slippage_vs_arrival_bps.toFixed(2)} bps`} tone={slipTone} />
        <Stat label="slip vs vwap" value={`${r.slippage_vs_vwap_bps.toFixed(2)} bps`} />
        <Stat label="unfilled" value={r.unfilled_shares.toLocaleString()} tone={r.unfilled_shares > 0 ? "down" : "neutral"} />
      </div>

      <Card title={`Fills (${r.fills.length})`} right={<Lightning weight="duotone" className="text-[var(--accent)]" size={16} />}>
        {r.fills.length === 0 ? (
          <Empty title="No fills" hint="The schedule produced zero filled shares for this market." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="muted text-xs uppercase tracking-wide">
                  <th className="text-right py-2 pr-3">Bar</th>
                  <th className="text-right py-2 pr-3">Shares</th>
                  <th className="text-right py-2 pr-3">Fill</th>
                  <th className="text-right py-2 pr-3">Market</th>
                  <th className="text-right py-2 pr-3">Part.</th>
                  <th className="text-right py-2 pr-3">Slip (bps)</th>
                  <th className="text-right py-2 pr-3">Comm.</th>
                </tr>
              </thead>
              <tbody>
                {r.fills.map((f, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="py-2 pr-3 text-right mono text-xs">{f.bar_index}</td>
                    <td className="py-2 pr-3 text-right num">{f.shares.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right num">${f.fill_price.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right num muted">${f.market_price.toFixed(4)}</td>
                    <td className="py-2 pr-3 text-right num">{(f.participation * 100).toFixed(1)}%</td>
                    <td className={`py-2 pr-3 text-right num ${f.slippage_bps > 5 ? "down" : ""}`}>{f.slippage_bps.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right num">{fmtUsd(f.commission, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
