"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Field } from "@/components/ui";
import { swrFetcher, type CorrelationMatrix, type Diversification } from "@/lib/api";
import { GridFour, Warning, ChartLine, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { correlationToCSV, correlationToJSON, correlationFilename } from "@/lib/correlationExport";
import {
  CORR_THRESHOLD_DEFAULT,
  CORR_WINDOW_DEFAULT,
  parseCorrelationUrlState,
  serializeCorrelationUrlState,
} from "@/lib/correlationUrl";

export default function CorrelationPage() {
  return (
    <AuthGate>
      <Correlation />
    </AuthGate>
  );
}

function Correlation() {
  const [window, setWindow] = useState(CORR_WINDOW_DEFAULT);
  const [threshold, setThreshold] = useState(CORR_THRESHOLD_DEFAULT);
  const [appliedWindow, setAppliedWindow] = useState(CORR_WINDOW_DEFAULT);
  const [appliedThr, setAppliedThr] = useState(CORR_THRESHOLD_DEFAULT);
  const [hydrated, setHydrated] = useState(false);

  const corrKey = `/correlation?window=${appliedWindow}`;
  const divKey = `/diversification?window=${appliedWindow}&threshold=${appliedThr}`;

  const corr = useSWR<CorrelationMatrix>(corrKey, swrFetcher);
  const div = useSWR<Diversification>(divKey, swrFetcher);

  // Hydrate window and threshold from the URL once so /correlation?window=120&threshold=0.85
  // works as a shareable deep link.
  useEffect(() => {
    const s = parseCorrelationUrlState(globalThis.window.location.search);
    setWindow(s.window);
    setThreshold(s.threshold);
    setAppliedWindow(s.window);
    setAppliedThr(s.threshold);
    setHydrated(true);
  }, []);

  // After hydration, mirror the applied state back to the address bar so the
  // current view is shareable by copying the URL. replaceState avoids
  // polluting browser history each time Apply is clicked.
  useEffect(() => {
    if (!hydrated) return;
    const qs = serializeCorrelationUrlState({ window: appliedWindow, threshold: appliedThr });
    const loc = globalThis.window.location;
    const next = qs ? `${loc.pathname}?${qs}` : loc.pathname;
    const current = loc.pathname + loc.search;
    if (next !== current) globalThis.window.history.replaceState(null, "", next);
  }, [hydrated, appliedWindow, appliedThr]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    setAppliedWindow(Math.max(5, Math.min(500, window || 60)));
    setAppliedThr(Math.max(0.1, Math.min(0.99, threshold || 0.7)));
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <GridFour weight="duotone" />
          Correlation
        </h1>
        <p className="muted text-xs">Pairwise return correlation across the watchlist plus cluster warnings.</p>
      </header>

      <Card>
        <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
          <Field label="Window (bars)">
            <Input type="number" min={5} max={500} value={window}
              onChange={(e) => setWindow(parseInt(e.target.value || "60", 10))} />
          </Field>
          <Field label="Cluster threshold">
            <Input type="number" step="0.01" min={0.1} max={0.99} value={threshold}
              onChange={(e) => setThreshold(parseFloat(e.target.value || "0.7"))} />
          </Field>
          <Button type="submit">
            <ChartLine weight="duotone" className="inline mr-1" />
            Apply
          </Button>
        </form>
      </Card>

      <DiversificationCard data={div.data} error={div.error} loading={div.isLoading} />
      <MatrixCard data={corr.data} error={corr.error} loading={corr.isLoading} />
    </div>
  );
}

function DiversificationCard({
  data, error, loading,
}: { data?: Diversification; error: unknown; loading: boolean }) {
  return (
    <Card title="Diversification">
      {error ? <ErrorBox err={error} /> :
        loading || !data ? <Loading /> :
          data.n_tickers === 0 ? (
            <Empty title="No tickers" hint="Add tickers to your watchlist to compute diversification." />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Tickers" value={data.n_tickers} />
              <Metric label="Avg pairwise corr" value={data.avg_pairwise_corr.toFixed(3)} />
              <Metric label="Max pairwise corr" value={data.max_pairwise_corr.toFixed(3)}
                tone={data.max_pairwise_corr >= data.threshold ? "warn" : "neutral"} />
              <Metric label="Most correlated"
                value={data.most_correlated_pair?.join(" / ") || "n/a"} />
              <div className="md:col-span-4">
                <div className="muted text-xs uppercase tracking-wide mb-1">Clusters</div>
                {data.clusters.length === 0 ? (
                  <div className="text-sm muted">No high-correlation clusters at threshold {data.threshold}.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {data.clusters.map((cl, i) => (
                      <div key={i} className="panel p-2 text-xs flex gap-1 flex-wrap">
                        {cl.map((t) => (
                          <Link key={t} href={`/ticker/${t}`}
                            className="mono px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10">{t}</Link>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {data.warnings.length > 0 && (
                <div className="md:col-span-4 space-y-1">
                  {data.warnings.map((w, i) => (
                    <div key={i} className="text-xs flex items-start gap-2">
                      <Warning weight="duotone" className="text-[var(--amber)] shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" | "neutral" }) {
  return (
    <div className="panel p-3">
      <div className="muted text-xs uppercase tracking-wide">{label}</div>
      <div className={"mt-1 text-lg num " + (tone === "warn" ? "down" : "")}>{value}</div>
    </div>
  );
}

function downloadBlob(content: string, mime: string, filename: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the download starts in all browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function corrColor(v: number): string {
  // -1 red, 0 transparent, +1 green
  if (!Number.isFinite(v)) return "transparent";
  const a = Math.min(1, Math.abs(v));
  if (v >= 0) return `rgba(46, 204, 113, ${a * 0.55})`;
  return `rgba(231, 76, 60, ${a * 0.55})`;
}

function MatrixCard({
  data, error, loading,
}: { data?: CorrelationMatrix; error: unknown; loading: boolean }) {
  const { tickers, matrix } = useMemo(() => ({
    tickers: data?.tickers ?? [],
    matrix: data?.matrix ?? [],
  }), [data]);

  return (
    <Card title={`Pairwise correlation (window ${data?.window ?? "..."})`}>
      {error ? <ErrorBox err={error} /> :
        loading || !data ? <Loading /> :
          tickers.length === 0 || matrix.length === 0 ? (
            <Empty title="No data" hint="Need price history for at least two tickers." />
          ) : (
            <div className="overflow-x-auto">
              <div className="flex flex-wrap gap-2 mb-3 text-xs">
                <button
                  type="button"
                  onClick={() => downloadBlob(
                    correlationToCSV(data),
                    "text/csv;charset=utf-8",
                    correlationFilename(data.window, "csv"),
                  )}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
                  title="Download the correlation matrix as CSV for spreadsheet analysis"
                  data-testid="correlation-export-csv"
                >
                  <DownloadSimple size={12} weight="bold" /> CSV
                </button>
                <button
                  type="button"
                  onClick={() => downloadBlob(
                    correlationToJSON(data),
                    "application/json;charset=utf-8",
                    correlationFilename(data.window, "json"),
                  )}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
                  title="Download the correlation matrix as JSON"
                  data-testid="correlation-export-json"
                >
                  <DownloadSimple size={12} weight="bold" /> JSON
                </button>
              </div>
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="p-1 sticky left-0 bg-[var(--bg)]"></th>
                    {tickers.map((t) => (
                      <th key={t} className="p-1 mono font-normal muted">{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.map((row, i) => (
                    <tr key={tickers[i]}>
                      <td className="p-1 mono font-medium sticky left-0 bg-[var(--bg)]">{tickers[i]}</td>
                      {row.map((v, j) => (
                        <td
                          key={j}
                          className="p-1 text-center num border border-[var(--border)]/40"
                          style={{ background: i === j ? "rgba(255,255,255,0.04)" : corrColor(v), minWidth: 46 }}
                          title={`${tickers[i]} / ${tickers[j]}: ${v.toFixed(3)}`}
                        >
                          {i === j ? "1.00" : v.toFixed(2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex items-center gap-3 text-xs muted">
                <Badge tone="down">negative</Badge>
                <Badge tone="up">positive</Badge>
                <span>Cells colored by sign and magnitude.</span>
              </div>
            </div>
          )}
    </Card>
  );
}
