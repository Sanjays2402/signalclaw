"use client";
import { use, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Stat, Loading, ErrorBox, Empty, Button, Input, Field, fmtPct } from "@/components/ui";
import { swrFetcher, type OptResult } from "@/lib/api";
import { ArrowLeft, Crosshair, ArrowsClockwise, ChartLineUp } from "@phosphor-icons/react/dist/ssr";

export default function Page({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  return (
    <AuthGate>
      <View symbol={symbol.toUpperCase()} />
    </AuthGate>
  );
}

function View({ symbol }: { symbol: string }) {
  const [train, setTrain] = useState(252);
  const [test, setTest] = useState(63);
  const [refresh, setRefresh] = useState(0);
  const [applied, setApplied] = useState({ train: 252, test: 63 });
  const key = `/optimize/${symbol}?train=${applied.train}&test=${applied.test}${refresh ? `&refresh=true&_=${refresh}` : ""}`;
  const { data, error, isLoading, mutate } = useSWR<OptResult>(key, swrFetcher, { shouldRetryOnError: false });

  function apply(e: React.FormEvent) {
    e.preventDefault();
    setApplied({ train, test });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/optimize" className="muted hover:text-white inline-flex items-center gap-1 text-sm">
            <ArrowLeft weight="duotone" size={14} /> optimizer
          </Link>
          <h1 className="text-2xl font-semibold mono">{symbol}</h1>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/ticker/${symbol}`}
            className="text-xs px-3 py-1.5 rounded border border-[var(--border)] hover:bg-white/5 inline-flex items-center gap-1.5"
          >
            <ChartLineUp weight="duotone" size={14} /> Ticker page
          </Link>
          <Button
            variant="ghost"
            onClick={() => {
              setRefresh(Date.now());
              setTimeout(() => mutate(), 0);
            }}
            title="Re-fetch OHLCV before optimizing"
            className="inline-flex items-center gap-1.5"
          >
            <ArrowsClockwise weight="duotone" size={14} /> Force refresh
          </Button>
        </div>
      </div>

      <Card title="Windows">
        <form onSubmit={apply} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Field label="Train (bars)">
            <Input type="number" min={50} max={2000} value={train} onChange={(e) => setTrain(Math.max(50, parseInt(e.target.value || "252", 10)))} />
          </Field>
          <Field label="Test (bars)">
            <Input type="number" min={10} max={500} value={test} onChange={(e) => setTest(Math.max(10, parseInt(e.target.value || "63", 10)))} />
          </Field>
          <Button type="submit" className="inline-flex items-center gap-1.5">
            <Crosshair weight="duotone" size={14} /> Run
          </Button>
        </form>
      </Card>

      {error ? <ErrorBox err={error} /> :
        isLoading || !data ? <Loading label="Searching parameter grid" /> :
          data.folds.length === 0 ? (
            <Empty title="No folds produced" hint="Try shrinking train or test window, or refresh OHLCV." />
          ) : (
            <Body data={data} />
          )}
    </div>
  );
}

function Body({ data }: { data: OptResult }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="folds" value={data.n_folds.toString()} />
        <Stat label="grid size" value={data.grid_size.toString()} />
        <Stat
          label="median test sharpe"
          value={data.median_test_sharpe.toFixed(2)}
          tone={data.median_test_sharpe > 0 ? "up" : "down"}
        />
        <Stat
          label="mean test return"
          value={fmtPct(data.mean_test_return)}
          tone={data.mean_test_return > 0 ? "up" : "down"}
        />
      </div>

      <Card title="Most common parameters">
        {data.most_common_params ? (
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span className="mono px-2 py-1 rounded border border-[var(--border)]">
              [{data.most_common_params.map((p) => p.toString()).join(", ")}]
            </span>
            <span className="muted text-xs">
              chosen in {(data.most_common_share * 100).toFixed(0)}% of folds
            </span>
          </div>
        ) : (
          <Empty title="No dominant parameter set" hint="Selection varied across folds." />
        )}
      </Card>

      <Card title="Folds">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="muted text-xs uppercase tracking-wide">
                <th className="text-left py-2 pr-3">Train</th>
                <th className="text-left py-2 pr-3">Test</th>
                <th className="text-left py-2 pr-3">Chosen</th>
                <th className="text-right py-2 pr-3">Train SR</th>
                <th className="text-right py-2 pr-3">Test SR</th>
                <th className="text-right py-2 pr-3">Test ret</th>
                <th className="text-right py-2 pr-3">Hit</th>
                <th className="text-right py-2 pr-3">Max DD</th>
              </tr>
            </thead>
            <tbody>
              {data.folds.map((f, i) => (
                <tr key={i} className="border-t border-[var(--border)]">
                  <td className="py-2 pr-3 mono text-xs">{f.train_start} → {f.train_end}</td>
                  <td className="py-2 pr-3 mono text-xs">{f.test_start} → {f.test_end}</td>
                  <td className="py-2 pr-3 mono text-xs">[{f.chosen.join(", ")}]</td>
                  <td className="py-2 pr-3 text-right num">{f.train_sharpe.toFixed(2)}</td>
                  <td className={`py-2 pr-3 text-right num ${f.test_sharpe >= 0 ? "up" : "down"}`}>{f.test_sharpe.toFixed(2)}</td>
                  <td className={`py-2 pr-3 text-right num ${f.test_return >= 0 ? "up" : "down"}`}>{fmtPct(f.test_return)}</td>
                  <td className="py-2 pr-3 text-right num">{fmtPct(f.test_hit_rate)}</td>
                  <td className="py-2 pr-3 text-right num down">{fmtPct(f.test_max_drawdown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
