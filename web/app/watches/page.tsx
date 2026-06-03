"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import {
  Card,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Input,
  Select,
  Field,
} from "@/components/ui";
import { api, swrFetcher, ApiError } from "@/lib/api";
import { watchesToCSV, watchesToJSON, watchesFilename } from "@/lib/watchesExport";
import { Eye, Trash, Plus, Play, ArrowRight, Clock, DownloadSimple } from "@phosphor-icons/react/dist/ssr";

function downloadBlob(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type Watch = {
  id: string;
  ticker: string;
  lookback_days: number;
  cadence_hours: number;
  enabled: boolean;
  label: string;
  created_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_regime: string | null;
  last_error: string | null;
  runs_count: number;
};

const CADENCES = [
  { v: 1, l: "hourly" },
  { v: 4, l: "every 4h" },
  { v: 12, l: "every 12h" },
  { v: 24, l: "daily" },
  { v: 168, l: "weekly" },
];

export default function WatchesPage() {
  return (
    <AuthGate>
      <Watches />
    </AuthGate>
  );
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function nextDue(w: Watch): string {
  if (!w.enabled) return "paused";
  if (!w.last_run_at) return "due now";
  const t = Date.parse(w.last_run_at) + w.cadence_hours * 3600_000;
  const ms = t - Date.now();
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

function Watches() {
  const { data, error, isLoading } = useSWR<{ watches: Watch[]; total: number; limit: number }>(
    "/api/watches",
    swrFetcher,
    { refreshInterval: 15_000 },
  );
  const [ticker, setTicker] = useState("");
  const [lookback, setLookback] = useState(180);
  const [cadence, setCadence] = useState(24);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    setBusy("create");
    try {
      await api("/api/watches", {
        method: "POST",
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase(),
          lookback_days: Number(lookback),
          cadence_hours: Number(cadence),
          label: label.trim() || undefined,
        }),
      });
      setTicker("");
      setLabel("");
      await mutate("/api/watches");
    } catch (e) {
      if (e instanceof ApiError) {
        try {
          const j = JSON.parse(e.body);
          setFormErr(j?.error?.message || e.body);
        } catch {
          setFormErr(e.body || e.message);
        }
      } else {
        setFormErr((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this watch?")) return;
    setBusy(id);
    try {
      await api(`/api/watches/${id}`, { method: "DELETE" });
      await mutate("/api/watches");
    } finally {
      setBusy(null);
    }
  }

  async function toggle(w: Watch) {
    setBusy(w.id);
    try {
      await api(`/api/watches/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      await mutate("/api/watches");
    } finally {
      setBusy(null);
    }
  }

  async function runNow(id: string) {
    setBusy(id);
    try {
      await api(`/api/watches/run?id=${encodeURIComponent(id)}`, { method: "POST" });
      await mutate("/api/watches");
    } finally {
      setBusy(null);
    }
  }

  const watches = data?.watches ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="muted text-[10px] uppercase tracking-widest mb-1">Scheduler</div>
          <h1 className="text-xl font-semibold mono">Watches</h1>
          <p className="muted text-[12px] mt-1 max-w-2xl">
            Schedule recurring regime runs for a ticker. Each tick saves a run to history. Regime changes raise an
            activity event. Wire a cron to POST <code className="mono">/api/watches/run</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              watches.length > 0 &&
              downloadBlob(
                watchesToCSV(watches),
                "text/csv;charset=utf-8",
                watchesFilename("csv"),
              )
            }
            disabled={watches.length === 0}
            data-testid="watches-export-csv"
            title="Download watches as CSV"
          >
            <DownloadSimple size={14} weight="duotone" /> CSV
          </Button>
          <Button
            onClick={() =>
              watches.length > 0 &&
              downloadBlob(
                watchesToJSON(watches),
                "application/json;charset=utf-8",
                watchesFilename("json"),
              )
            }
            disabled={watches.length === 0}
            data-testid="watches-export-json"
            title="Download watches as JSON"
          >
            <DownloadSimple size={14} weight="duotone" /> JSON
          </Button>
          <div className="text-[11px] muted mono">
            {data ? `${data.total}/${data.limit} watches` : ""}
          </div>
        </div>
      </header>

      <Card>
        <form onSubmit={create} className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3">
          <Field label="Ticker">
            <Input
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="SPY"
              required
              maxLength={16}
              aria-label="Ticker"
            />
          </Field>
          <Field label="Lookback (days)">
            <Input
              type="number"
              min={30}
              max={365}
              value={lookback}
              onChange={(e) => setLookback(Number(e.target.value))}
              required
              aria-label="Lookback days"
            />
          </Field>
          <Field label="Cadence">
            <Select value={cadence} onChange={(e) => setCadence(Number(e.target.value))} aria-label="Cadence">
              {CADENCES.map((c) => (
                <option key={c.v} value={c.v}>
                  {c.l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Label (optional)">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="SPY daily check"
              maxLength={80}
              aria-label="Label"
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy === "create"}>
              <Plus size={14} weight="duotone" /> {busy === "create" ? "Adding" : "Add watch"}
            </Button>
          </div>
        </form>
        {formErr ? (
          <div className="text-[11px] mt-2" style={{ color: "var(--red)" }}>
            {formErr}
          </div>
        ) : null}
      </Card>

      {isLoading ? (
        <Loading label="Loading watches" />
      ) : error ? (
        <ErrorBox err={error} />
      ) : watches.length === 0 ? (
        <Empty title="No watches yet" hint="Add a ticker above to schedule recurring regime runs." />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] mono">
              <thead className="muted text-left">
                <tr className="border-b border-[var(--border)]">
                  <th className="py-2 pr-3">Ticker</th>
                  <th className="py-2 pr-3 hidden sm:table-cell">Cadence</th>
                  <th className="py-2 pr-3 hidden md:table-cell">Lookback</th>
                  <th className="py-2 pr-3">Last regime</th>
                  <th className="py-2 pr-3 hidden md:table-cell">Last run</th>
                  <th className="py-2 pr-3 hidden sm:table-cell">Next</th>
                  <th className="py-2 pr-3">Runs</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-0 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {watches.map((w) => (
                  <tr key={w.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-semibold">{w.ticker}</div>
                      <div className="muted text-[10px] truncate max-w-[160px]">{w.label}</div>
                    </td>
                    <td className="py-2 pr-3 hidden sm:table-cell">
                      {CADENCES.find((c) => c.v === w.cadence_hours)?.l ?? `${w.cadence_hours}h`}
                    </td>
                    <td className="py-2 pr-3 hidden md:table-cell">{w.lookback_days}d</td>
                    <td className="py-2 pr-3">
                      {w.last_regime ? (
                        <Badge tone="info">{w.last_regime}</Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 hidden md:table-cell muted">
                      <Clock size={11} weight="duotone" className="inline mr-1" />
                      {fmtAgo(w.last_run_at)}
                    </td>
                    <td className="py-2 pr-3 hidden sm:table-cell muted">{nextDue(w)}</td>
                    <td className="py-2 pr-3">{w.runs_count}</td>
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => toggle(w)}
                        disabled={busy === w.id}
                        className="text-[11px] underline-offset-2 hover:underline"
                        aria-label={w.enabled ? "Pause watch" : "Resume watch"}
                      >
                        {w.enabled ? (
                          <Badge tone="up">active</Badge>
                        ) : (
                          <Badge tone="neutral">paused</Badge>
                        )}
                      </button>
                      {w.last_error ? (
                        <div className="text-[10px] mt-1" style={{ color: "var(--red)" }} title={w.last_error}>
                          err: {w.last_error.slice(0, 32)}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-0 text-right whitespace-nowrap">
                      <button
                        onClick={() => runNow(w.id)}
                        disabled={busy === w.id}
                        className="mr-3 inline-flex items-center gap-1 hover:text-white"
                        title="Run now"
                        aria-label="Run watch now"
                      >
                        <Play size={12} weight="duotone" /> Run
                      </button>
                      {w.last_run_id ? (
                        <Link
                          href={`/r/${w.last_run_id}`}
                          className="mr-3 inline-flex items-center gap-1 hover:text-white"
                          aria-label="View last saved run"
                        >
                          <Eye size={12} weight="duotone" /> Last
                        </Link>
                      ) : null}
                      <button
                        onClick={() => remove(w.id)}
                        disabled={busy === w.id}
                        className="inline-flex items-center gap-1 hover:text-red-400"
                        aria-label="Delete watch"
                      >
                        <Trash size={12} weight="duotone" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <div className="muted text-[10px] uppercase tracking-widest mb-2">Cron</div>
        <p className="text-[11px] muted mb-2">
          Tick the scheduler from any external cron (Vercel scheduled function, GitHub Actions, your own box).
          Set <code className="mono">WATCH_CRON_TOKEN</code> to require auth.
        </p>
        <pre className="text-[11px] mono overflow-x-auto p-3 rounded-sm bg-black/40 border border-[var(--border)]">
{`# Run all due watches
curl -X POST http://localhost:7430/api/watches/run \\
  -H "x-cron-token: $WATCH_CRON_TOKEN"

# Peek due count without running
curl http://localhost:7430/api/watches/run \\
  -H "x-cron-token: $WATCH_CRON_TOKEN"`}
        </pre>
        <div className="mt-3 text-[11px]">
          <Link href="/history?tag=watch" className="inline-flex items-center gap-1 hover:text-white">
            See auto-saved runs <ArrowRight size={12} weight="duotone" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
