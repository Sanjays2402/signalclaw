"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Stat,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Field,
  Input,
  fmtPct,
} from "@/components/ui";
import {
  swrFetcher,
  api,
  type Regime,
  type DrawdownReport,
  type Diversification,
  type CorrelationMatrix,
} from "@/lib/api";
import { Pulse, ShieldWarning, TrendDown, Broom, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import { correlationToCSV, correlationToJSON, correlationFilename } from "@/lib/correlationExport";

export default function Page() {
  return (
    <AuthGate>
      <Risk />
    </AuthGate>
  );
}

function regimeTone(label: string): "up" | "down" | "warn" | "info" {
  switch (label) {
    case "bull":
      return "up";
    case "neutral":
      return "info";
    case "chop":
      return "warn";
    case "bear":
    case "crash":
      return "down";
    default:
      return "info";
  }
}

function Risk() {
  const [bench, setBench] = useState("SPY");
  const reg = useSWR<Regime>(`/regime?ticker=${encodeURIComponent(bench)}`, swrFetcher, {
    refreshInterval: 60000,
  });
  const dd = useSWR<DrawdownReport>("/portfolio/drawdown", swrFetcher, {
    refreshInterval: 60000,
  });
  const div = useSWR<Diversification>("/diversification?window=60", swrFetcher);
  const corr = useSWR<CorrelationMatrix>("/correlation?window=60", swrFetcher);

  const [clearing, setClearing] = useState(false);
  const [clearErr, setClearErr] = useState<string | null>(null);
  async function clearTrip() {
    setClearing(true);
    setClearErr(null);
    try {
      await api("/portfolio/drawdown/clear", { method: "POST" });
      await mutate("/portfolio/drawdown");
    } catch (e) {
      setClearErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Risk</h1>
        <p className="muted text-xs mt-1">
          Market regime, portfolio drawdown guard, and diversification health.
        </p>
      </div>

      <Card
        title="Market regime"
        right={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get("t") as string;
              if (v) setBench(v.toUpperCase().trim());
            }}
          >
            <Field label="">
              <Input name="t" defaultValue={bench} className="w-24" />
            </Field>
            <Button variant="ghost" type="submit">
              Set
            </Button>
          </form>
        }
      >
        {reg.isLoading && <Loading label="Loading regime" />}
        {reg.error && <ErrorBox err={reg.error} />}
        {reg.data && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="panel p-4">
              <div className="muted text-xs uppercase tracking-wide flex items-center gap-1">
                <Pulse weight="duotone" size={12} /> regime
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Badge tone={regimeTone(reg.data.label)}>{reg.data.label}</Badge>
                <span className="muted text-xs num">{reg.data.as_of}</span>
              </div>
              <div className="muted text-xs mt-2">
                confidence {fmtPct(reg.data.confidence)}
              </div>
            </div>
            <Stat label="Realized vol" value={fmtPct(reg.data.realized_vol)} />
            <Stat
              label="Trend slope"
              value={reg.data.trend_slope.toFixed(4)}
              tone={reg.data.trend_slope >= 0 ? "up" : "down"}
            />
            <Stat
              label="Risk scale"
              value={reg.data.risk_scale.toFixed(2)}
              tone={reg.data.risk_scale >= 1 ? "up" : "down"}
            />
          </div>
        )}
      </Card>

      <Card
        title="Drawdown guard"
        right={
          dd.data?.state.tripped ? (
            <div className="flex items-center gap-2">
              {clearErr && <span className="text-xs down">{clearErr}</span>}
              <Button variant="danger" onClick={clearTrip} disabled={clearing}>
                <span className="inline-flex items-center gap-1.5">
                  <Broom weight="duotone" size={14} />
                  {clearing ? "Clearing" : "Clear trip"}
                </span>
              </Button>
            </div>
          ) : null
        }
      >
        {dd.isLoading && <Loading label="Loading drawdown" />}
        {dd.error && <ErrorBox err={dd.error} />}
        {dd.data && (
          <>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="panel p-4">
                <div className="muted text-xs uppercase tracking-wide flex items-center gap-1">
                  <ShieldWarning weight="duotone" size={12} /> status
                </div>
                <div className="mt-2">
                  <Badge tone={dd.data.state.tripped ? "down" : "up"}>
                    {dd.data.state.tripped ? "tripped" : "armed"}
                  </Badge>
                </div>
                {dd.data.state.reason && (
                  <div className="muted text-xs mt-2">{dd.data.state.reason}</div>
                )}
              </div>
              <Stat
                label="Equity"
                value={`$${dd.data.state.equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              />
              <Stat
                label="Drawdown"
                value={fmtPct(dd.data.state.drawdown)}
                tone={dd.data.state.drawdown <= -0.05 ? "down" : "neutral"}
              />
              <Stat
                label="Trigger / rearm"
                value={`${fmtPct(dd.data.config.trigger)} / ${fmtPct(dd.data.config.rearm)}`}
              />
            </div>
            <div className="muted text-xs mt-3">
              <TrendDown weight="duotone" size={12} className="inline mr-1" />
              Peak ${dd.data.state.peak.toLocaleString(undefined, { maximumFractionDigits: 0 })} on{" "}
              <span className="num">{dd.data.state.peak_date}</span>
            </div>
          </>
        )}
      </Card>

      <Card title="Diversification">
        {div.isLoading && <Loading label="Loading diversification" />}
        {div.error && <ErrorBox err={div.error} />}
        {div.data && div.data.n_tickers === 0 && (
          <Empty
            title="Not enough positions to diversify"
            hint="Add holdings on the Portfolio page."
          />
        )}
        {div.data && div.data.n_tickers > 0 && (
          <div className="space-y-3">
            <div className="grid sm:grid-cols-3 gap-3">
              <Stat label="Tickers" value={div.data.n_tickers} />
              <Stat
                label="Avg pairwise corr"
                value={div.data.avg_pairwise_corr.toFixed(2)}
                tone={div.data.avg_pairwise_corr >= div.data.threshold ? "down" : "up"}
              />
              <Stat
                label="Max pairwise corr"
                value={div.data.max_pairwise_corr.toFixed(2)}
              />
            </div>
            {div.data.warnings.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {div.data.warnings.map((w, i) => (
                  <Badge tone="warn" key={i}>
                    {w}
                  </Badge>
                ))}
              </div>
            )}
            {div.data.clusters.length > 0 && (
              <div>
                <div className="muted text-xs uppercase tracking-wide mb-1.5">
                  Clusters
                </div>
                <ul className="space-y-1">
                  {div.data.clusters.map((c, i) => (
                    <li key={i} className="num text-sm">
                      {c.join(", ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {corr.data && corr.data.tickers.length > 1 && (
              <CorrelationGrid m={corr.data} />
            )}
          </div>
        )}
      </Card>
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

function corrCellStyle(v: number): React.CSSProperties {
  const a = Math.min(Math.abs(v), 1);
  const color =
    v >= 0
      ? `rgba(34,197,94,${0.12 + a * 0.5})`
      : `rgba(239,68,68,${0.12 + a * 0.5})`;
  return { background: color };
}

function CorrelationGrid({ m }: { m: CorrelationMatrix }) {
  return (
    <div>
      <div className="muted text-xs uppercase tracking-wide mb-1.5 flex items-center justify-between gap-2">
        <span>Correlation ({m.window}d)</span>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => downloadBlob(
              correlationToCSV(m),
              "text/csv;charset=utf-8",
              correlationFilename(m.window, "csv"),
            )}
            className="inline-flex items-center gap-1 px-2 py-1 border border-[var(--border)] hover:border-[var(--accent)] rounded normal-case"
            title="Download the correlation matrix as CSV for spreadsheet analysis"
            data-testid="risk-correlation-export-csv"
          >
            <DownloadSimple size={12} weight="bold" /> CSV
          </button>
          <button
            type="button"
            onClick={() => downloadBlob(
              correlationToJSON(m),
              "application/json;charset=utf-8",
              correlationFilename(m.window, "json"),
            )}
            className="inline-flex items-center gap-1 px-2 py-1 border border-[var(--border)] hover:border-[var(--accent)] rounded normal-case"
            title="Download the correlation matrix as JSON"
            data-testid="risk-correlation-export-json"
          >
            <DownloadSimple size={12} weight="bold" /> JSON
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs num border-separate border-spacing-px">
          <thead>
            <tr>
              <th />
              {m.tickers.map((t) => (
                <th key={t} className="px-2 py-1 muted">
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.matrix.map((row, i) => (
              <tr key={m.tickers[i]}>
                <td className="px-2 py-1 muted">{m.tickers[i]}</td>
                {row.map((v, j) => (
                  <td
                    key={j}
                    className="px-2 py-1 text-center rounded"
                    style={corrCellStyle(v)}
                  >
                    {v.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
