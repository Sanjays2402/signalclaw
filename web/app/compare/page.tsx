"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, Loading, ErrorBox, Empty, Badge, Select, Field, fmtPct } from "@/components/ui";
import CompareChart from "@/components/CompareChart";
import {
  ArrowsLeftRight,
  ArrowRight,
  ClockCounterClockwise,
  Swap,
} from "@phosphor-icons/react/dist/ssr";

type RunListItem = {
  id: string;
  label: string;
  ticker: string;
  lookback_days: number;
  created_at: string;
  tags: string[];
  bars: number;
  regime: string | null;
  confidence: number | null;
};

type RunListResp = { runs: RunListItem[]; total: number; has_more: boolean };

type ComparePayload = {
  a: any;
  b: any;
  summary: {
    a: { bars: number; mix: Record<string, number>; regime: string | null; confidence: number | null; pct_change: number | null };
    b: { bars: number; mix: Record<string, number>; regime: string | null; confidence: number | null; pct_change: number | null };
    mix_diff: Record<string, number>;
  };
};

const REGIME_PALETTE: Record<string, string> = {
  bull: "#22C55E",
  chop: "#F59E0B",
  bear: "#F97316",
  crash: "#EF4444",
};

const A_COLOR = "#60A5FA";
const B_COLOR = "#F472B6";

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
};

function regimeTone(label: string | null): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

function pctSigned(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "--";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

export default function ComparePage() {
  // Pull a generous page of saved runs for the picker. Same shape used by /history.
  const { data: list, error: listErr, isLoading: listLoading } = useSWR<RunListResp>(
    "/api/runs?limit=100&offset=0",
    fetcher,
  );

  const runs = list?.runs ?? [];

  const [aId, setAId] = useState<string>("");
  const [bId, setBId] = useState<string>("");

  // Auto-pick the two most recent distinct runs once the list loads.
  useEffect(() => {
    if (runs.length >= 2 && !aId && !bId) {
      setAId(runs[0].id);
      setBId(runs[1].id);
    } else if (runs.length === 1 && !aId) {
      setAId(runs[0].id);
    }
  }, [runs, aId, bId]);

  const canCompare = aId && bId && aId !== bId;

  const { data: cmp, error: cmpErr, isLoading: cmpLoading } = useSWR<ComparePayload>(
    canCompare ? `/api/runs/compare?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}` : null,
    fetcher,
  );

  const series = useMemo(() => {
    if (!cmp) return [];
    return [
      { id: cmp.a.id, label: `A · ${cmp.a.ticker}`, color: A_COLOR, dates: cmp.a.payload.dates, close: cmp.a.payload.close },
      { id: cmp.b.id, label: `B · ${cmp.b.ticker}`, color: B_COLOR, dates: cmp.b.payload.dates, close: cmp.b.payload.close },
    ];
  }, [cmp]);

  function swap() {
    setAId(bId);
    setBId(aId);
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <section className="panel p-5 md:p-7">
        <div className="flex items-start gap-3">
          <ArrowsLeftRight size={22} weight="duotone" style={{ color: "var(--amber)" }} />
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Compare runs</h1>
            <p className="muted text-[12px]">
              Overlay two saved regime runs to see how the shape and mix differ. Both series are
              normalized to 100 at their first bar.
            </p>
          </div>
        </div>
      </section>

      <Card title="Pick two runs">
        {listLoading && <Loading label="Loading saved runs" />}
        {listErr && <ErrorBox err={listErr} />}
        {!listLoading && !listErr && runs.length === 0 && (
          <Empty
            title="No saved runs yet"
            hint="Save a run from the Demo page, then return here to compare two of them."
          />
        )}
        {!listLoading && !listErr && runs.length === 1 && (
          <Empty
            title="Only one saved run"
            hint="Save at least one more run from Demo to enable compare."
          />
        )}
        {runs.length >= 2 && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <Field label="Run A">
              <Select value={aId} onChange={(e) => setAId(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id} disabled={r.id === bId}>
                    {r.ticker} · {r.label} · {new Date(r.created_at).toISOString().slice(0, 10)}
                  </option>
                ))}
              </Select>
            </Field>
            <button
              type="button"
              onClick={swap}
              aria-label="Swap A and B"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5 justify-center self-end"
            >
              <Swap size={12} weight="bold" /> Swap
            </button>
            <Field label="Run B">
              <Select value={bId} onChange={(e) => setBId(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id} disabled={r.id === aId}>
                    {r.ticker} · {r.label} · {new Date(r.created_at).toISOString().slice(0, 10)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Card>

      {canCompare && cmpLoading && <Loading label="Loading comparison" />}
      {canCompare && cmpErr && <ErrorBox err={cmpErr} />}

      {cmp && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(["a", "b"] as const).map((k) => {
              const r = cmp[k];
              const s = cmp.summary[k];
              const color = k === "a" ? A_COLOR : B_COLOR;
              return (
                <Card
                  key={k}
                  title={
                    <span className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: color }} />
                      <span className="mono uppercase tracking-widest text-[10px]">
                        {k === "a" ? "Run A" : "Run B"}
                      </span>
                      <span className="font-semibold">{r.ticker}</span>
                    </span>
                  }
                >
                  <div className="space-y-2">
                    <div className="text-[12px]">{r.label}</div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] mono">
                      <Badge tone={regimeTone(s.regime)}>{(s.regime ?? "--").toUpperCase()}</Badge>
                      <span className="muted uppercase">
                        conf {s.confidence !== null ? `${(s.confidence * 100).toFixed(0)}%` : "--"}
                      </span>
                      <span className="muted">·</span>
                      <span className="muted uppercase">{s.bars} bars</span>
                      <span className="muted">·</span>
                      <span className="muted uppercase">{r.lookback_days}d window</span>
                    </div>
                    <div className="text-[11px] mono muted">
                      Window return:{" "}
                      <span style={{ color: s.pct_change !== null && s.pct_change >= 0 ? "var(--green)" : "var(--red)" }}>
                        {pctSigned(s.pct_change)}
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <Card
            title="Normalized price overlay"
            right={<span className="mono text-[10px] muted">base = 100 at first bar</span>}
          >
            <CompareChart series={series} />
            <div className="flex flex-wrap gap-4 mt-3 text-[11px] mono uppercase tracking-widest">
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: A_COLOR }} />
                <span>A · {cmp.a.ticker}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: B_COLOR }} />
                <span>B · {cmp.b.ticker}</span>
              </div>
            </div>
          </Card>

          <Card title="Regime mix difference (B minus A)">
            <div className="space-y-3">
              {(["bull", "chop", "bear", "crash"] as const).map((k) => {
                const diff = cmp.summary.mix_diff[k] || 0;
                const aPct = (cmp.summary.a.mix[k] || 0) * 100;
                const bPct = (cmp.summary.b.mix[k] || 0) * 100;
                const tone = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--text-muted)";
                return (
                  <div key={k} className="grid grid-cols-[80px_1fr_80px] items-center gap-3 text-[11px] mono">
                    <div className="flex items-center gap-1.5 uppercase tracking-widest">
                      <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: REGIME_PALETTE[k] }} />
                      {k}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="muted w-16 text-right">A {aPct.toFixed(0)}%</span>
                      <div className="flex-1 h-2 rounded-sm border border-[var(--border)] overflow-hidden flex">
                        <div className="h-full" style={{ width: `${aPct}%`, background: A_COLOR, opacity: 0.55 }} />
                      </div>
                      <div className="flex-1 h-2 rounded-sm border border-[var(--border)] overflow-hidden flex">
                        <div className="h-full" style={{ width: `${bPct}%`, background: B_COLOR, opacity: 0.55 }} />
                      </div>
                      <span className="muted w-16">B {bPct.toFixed(0)}%</span>
                    </div>
                    <div className="text-right uppercase" style={{ color: tone }}>
                      {pctSigned(diff, 0)}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Link
              href={`/r/${cmp.a.id}`}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              Open A <ArrowRight size={12} weight="bold" />
            </Link>
            <Link
              href={`/r/${cmp.b.id}`}
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              Open B <ArrowRight size={12} weight="bold" />
            </Link>
            <Link
              href="/history"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--border)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              <ClockCounterClockwise size={12} weight="bold" /> History
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
