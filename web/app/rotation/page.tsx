"use client";
import { useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Field, Input, Button, fmtPct } from "@/components/ui";
import { swrFetcher, type RotationReport, type Concentration } from "@/lib/api";
import { ChartLineUp, ChartLineDown, Compass, Warning } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <Rotation />
    </AuthGate>
  );
}

function callTone(call: string): "up" | "down" | "warn" | "info" | "neutral" {
  switch (call.toLowerCase()) {
    case "overweight": return "up";
    case "underweight": return "down";
    case "neutral": return "info";
    default: return "neutral";
  }
}

function Rotation() {
  const [benchmark, setBenchmark] = useState("SPY");
  const [tickers, setTickers] = useState("");
  const [committed, setCommitted] = useState({ benchmark: "SPY", tickers: "" });

  const qs = new URLSearchParams({ benchmark: committed.benchmark });
  if (committed.tickers.trim()) qs.set("tickers", committed.tickers.trim());
  const rot = useSWR<RotationReport>(`/rotation?${qs.toString()}`, swrFetcher);
  const sec = useSWR<Concentration>("/portfolio/sectors", swrFetcher);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Compass weight="duotone" className="text-[var(--accent)]" size={22} />
            Rotation
          </h1>
          <p className="muted text-xs">
            Sector relative strength vs benchmark. Composite blends 1m, 3m, 6m returns, RS slope, and breadth.
          </p>
        </div>
      </header>

      <Card title="Controls">
        <form
          className="flex flex-wrap gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setCommitted({ benchmark: benchmark.toUpperCase().trim() || "SPY", tickers });
          }}
        >
          <div className="w-32">
            <Field label="Benchmark">
              <Input value={benchmark} onChange={(e) => setBenchmark(e.target.value)} placeholder="SPY" />
            </Field>
          </div>
          <div className="flex-1 min-w-[240px]">
            <Field label="Tickers (comma separated, optional)">
              <Input value={tickers} onChange={(e) => setTickers(e.target.value)} placeholder="defaults to your watchlist" />
            </Field>
          </div>
          <Button type="submit">Run</Button>
        </form>
      </Card>

      <Card
        title="Sector scores"
        right={rot.data && <span className="muted text-xs">as of {rot.data.asof} vs {rot.data.benchmark}</span>}
      >
        {rot.error ? <ErrorBox err={rot.error} /> :
          !rot.data ? <Loading label="Scoring sectors" /> :
            rot.data.scores.length === 0 ? (
              <Empty title="No sector scores" hint="Add tickers to your watchlist or pass an explicit list." />
            ) : (
              <SectorGrid report={rot.data} />
            )}
      </Card>

      <Card title="Portfolio sector exposure">
        {sec.error ? (
          (sec.error as { status?: number })?.status === 404
            ? <Empty title="No positions yet" hint="Log trades in Portfolio to see sector exposure." />
            : <ErrorBox err={sec.error} />
        ) :
          !sec.data ? <Loading label="Computing exposure" /> :
            sec.data.sectors.length === 0 ? (
              <Empty title="No sector data" hint="Position metadata is missing sector mappings." />
            ) : (
              <SectorExposureTable data={sec.data} />
            )}
      </Card>
    </div>
  );
}

function SectorGrid({ report }: { report: RotationReport }) {
  const sorted = [...report.scores].sort((a, b) => b.composite - a.composite);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((s) => (
        <div key={s.sector} className="panel p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-medium text-sm">{s.sector}</div>
            <Badge tone={callTone(s.call)}>{s.call}</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Metric label="1M" value={s.ret_1m} />
            <Metric label="3M" value={s.ret_3m} />
            <Metric label="6M" value={s.ret_6m} />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="muted">Composite</span>
            <span className={`num ${s.composite >= 0 ? "up" : "down"}`}>{s.composite.toFixed(3)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="muted">Breadth</span>
            <span className="num">{fmtPct(s.breadth)}</span>
          </div>
          {s.members.length > 0 && (
            <div className="muted text-[11px] truncate" title={s.members.join(", ")}>
              {s.members.slice(0, 6).join(", ")}{s.members.length > 6 ? ` +${s.members.length - 6}` : ""}
            </div>
          )}
        </div>
      ))}
      {(report.skipped_unknown_sector.length > 0 || report.skipped_short_history.length > 0) && (
        <div className="panel p-3 text-xs muted md:col-span-2 lg:col-span-3 flex items-start gap-2">
          <Warning weight="duotone" className="text-[var(--amber)] shrink-0 mt-0.5" size={14} />
          <div>
            {report.skipped_unknown_sector.length > 0 && (
              <div>Skipped (no sector): {report.skipped_unknown_sector.join(", ")}</div>
            )}
            {report.skipped_short_history.length > 0 && (
              <div>Skipped (short history): {report.skipped_short_history.join(", ")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  const tone = value >= 0 ? "up" : "down";
  const Icon = value >= 0 ? ChartLineUp : ChartLineDown;
  return (
    <div className="flex flex-col">
      <span className="muted">{label}</span>
      <span className={`num ${tone} flex items-center gap-1`}>
        <Icon weight="duotone" size={12} />
        {fmtPct(value, 1)}
      </span>
    </div>
  );
}

function SectorExposureTable({ data }: { data: Concentration }) {
  const sorted = [...data.sectors].sort((a, b) => b.weight - a.weight);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Stat label="HHI" value={data.hhi.toFixed(3)} />
        <Stat label="Effective sectors" value={data.effective_n_sectors.toFixed(2)} />
        <Stat label="Max sector" value={data.max_sector ? `${data.max_sector} ${fmtPct(data.max_sector_weight, 1)}` : "n/a"} />
        <Stat label="Max position" value={data.max_position ? `${data.max_position} ${fmtPct(data.max_position_weight, 1)}` : "n/a"} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left muted text-xs uppercase tracking-wide">
            <tr>
              <th className="py-2 pr-3">Sector</th>
              <th className="py-2 pr-3 text-right">Weight</th>
              <th className="py-2 pr-3 text-right">Market value</th>
              <th className="py-2 pr-3">Tickers</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const breach = s.weight > data.sector_cap;
              return (
                <tr key={s.sector} className="border-t border-[var(--border)]">
                  <td className="py-2 pr-3 font-medium">{s.sector}</td>
                  <td className={`py-2 pr-3 text-right num ${breach ? "down" : ""}`}>
                    {fmtPct(s.weight, 1)}
                    {breach && <span className="ml-1 text-[10px] uppercase">over cap</span>}
                  </td>
                  <td className="py-2 pr-3 text-right num">${s.market_value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  <td className="py-2 pr-3 muted text-xs">{s.tickers.join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.breaches.length > 0 && (
        <div className="panel p-3 text-xs flex items-start gap-2 border-[var(--amber)]/40">
          <Warning weight="duotone" className="text-[var(--amber)] shrink-0 mt-0.5" size={14} />
          <div>
            <div className="text-[var(--amber)] font-medium">Concentration breaches</div>
            <ul className="muted mt-1 list-disc pl-4">
              {data.breaches.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel p-3">
      <div className="muted text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-sm num mt-1">{value}</div>
    </div>
  );
}
