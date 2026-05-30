"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { Card, Stat, Badge, Loading, ErrorBox, Empty, Button, Input, Field } from "@/components/ui";
import { swrFetcher, type Diversification } from "@/lib/api";
import { Graph, ShieldWarning, ArrowRight } from "@phosphor-icons/react/dist/ssr";

export default function Page() {
  return (
    <AuthGate>
      <DivView />
    </AuthGate>
  );
}

function DivView() {
  const [window, setWindow] = useState(60);
  const [threshold, setThreshold] = useState(0.7);
  const [applied, setApplied] = useState({ window: 60, threshold: 0.7 });
  const key = `/diversification?window=${applied.window}&threshold=${applied.threshold}`;
  const { data, error, isLoading, mutate } = useSWR<Diversification>(key, swrFetcher);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    setApplied({ window, threshold });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold">Diversification</h1>
          <p className="muted text-xs">Pairwise correlation clusters across the watchlist, weighted by portfolio if a snapshot exists.</p>
        </div>
        <Button variant="ghost" onClick={() => mutate()}>Refresh</Button>
      </header>

      <Card title="Parameters">
        <form onSubmit={apply} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Field label="Window (bars)">
            <Input
              type="number"
              min={10}
              max={500}
              value={window}
              onChange={(e) => setWindow(Math.max(10, parseInt(e.target.value || "60", 10)))}
            />
          </Field>
          <Field label="Cluster threshold (corr)">
            <Input
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={threshold}
              onChange={(e) => setThreshold(Math.min(1, Math.max(0, parseFloat(e.target.value || "0.7"))))}
            />
          </Field>
          <Button type="submit">Recompute</Button>
        </form>
      </Card>

      {error ? <ErrorBox err={error} /> :
        isLoading || !data ? <Loading label="Computing correlation matrix" /> :
          <Body data={data} />}
    </div>
  );
}

function Body({ data }: { data: Diversification }) {
  if (data.n_tickers < 2) {
    return <Empty title="Not enough tickers to cluster" hint="Add at least two tickers with cached OHLCV to the watchlist." />;
  }
  const pair = data.most_correlated_pair;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="tickers" value={data.n_tickers.toString()} />
        <Stat label="avg pairwise corr" value={data.avg_pairwise_corr.toFixed(3)} />
        <Stat
          label="max pairwise corr"
          value={data.max_pairwise_corr.toFixed(3)}
          tone={data.max_pairwise_corr >= data.threshold ? "down" : "neutral"}
        />
        <Stat label="window" value={`${data.window}b`} />
      </div>

      {pair && pair.length === 2 && (
        <Card title="Tightest pair">
          <div className="flex items-center gap-3 text-sm">
            <Link href={`/ticker/${pair[0]}`} className="mono px-2 py-1 rounded border border-[var(--border)] hover:bg-white/5">{pair[0]}</Link>
            <ArrowRight weight="duotone" className="muted" size={16} />
            <Link href={`/ticker/${pair[1]}`} className="mono px-2 py-1 rounded border border-[var(--border)] hover:bg-white/5">{pair[1]}</Link>
            <Badge tone={data.max_pairwise_corr >= data.threshold ? "warn" : "info"}>
              ρ = {data.max_pairwise_corr.toFixed(3)}
            </Badge>
          </div>
        </Card>
      )}

      <Card title={`Clusters above ρ ≥ ${data.threshold}`} right={<Graph weight="duotone" className="text-[var(--accent)]" size={16} />}>
        {data.clusters.length === 0 ? (
          <Empty title="No tight clusters" hint="Holdings look well diversified at this threshold." />
        ) : (
          <ul className="space-y-2">
            {data.clusters.map((c, i) => (
              <li key={i} className="flex items-center gap-2 flex-wrap text-sm">
                <span className="muted text-xs uppercase tracking-wide mr-1">#{i + 1}</span>
                {c.map((t) => (
                  <Link
                    key={t}
                    href={`/ticker/${t}`}
                    className="mono px-2 py-0.5 rounded border border-[var(--border)] hover:bg-white/5"
                  >
                    {t}
                  </Link>
                ))}
                <span className="muted text-xs ml-1">{c.length} names</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Warnings" right={<ShieldWarning weight="duotone" className="text-[var(--amber)]" size={16} />}>
        {data.warnings.length === 0 ? (
          <Empty title="No warnings" hint="Correlation profile is within thresholds." />
        ) : (
          <ul className="space-y-2 text-sm">
            {data.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <ShieldWarning weight="duotone" className="text-[var(--amber)] mt-0.5 shrink-0" size={14} />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="text-xs muted">
        Avg pairwise correlation is the mean of off-diagonal entries. Lower means more independent return streams.
      </div>
    </div>
  );
}

