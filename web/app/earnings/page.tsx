"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Field } from "@/components/ui";
import { api, swrFetcher, type EarningsList, type EarningsIn } from "@/lib/api";
import { earningsToCSV, earningsToJSON, earningsFilename } from "@/lib/earningsExport";
import { CalendarBlank, Trash, FloppyDisk, CheckCircle, Circle, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

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
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function EarningsPage() {
  return (
    <AuthGate>
      <Earnings />
    </AuthGate>
  );
}

function daysUntil(iso: string): number | null {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

function Earnings() {
  const [within, setWithin] = useState<number | null>(null);
  const key = within ? `/earnings?within_days=${within}` : "/earnings";
  const { data, error, isLoading } = useSWR<EarningsList>(key, swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  async function upsert(ticker: string, body: EarningsIn) {
    setFormErr(null);
    setBusy(ticker);
    try {
      await api(`/earnings/${encodeURIComponent(ticker.toUpperCase())}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await mutate(key);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(ticker: string) {
    setBusy(ticker);
    try {
      await api(`/earnings/${encodeURIComponent(ticker)}`, { method: "DELETE" });
      await mutate(key);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <CalendarBlank weight="duotone" size={22} className="text-[var(--accent)]" />
            Earnings
          </h1>
          <p className="muted text-xs">Upcoming earnings dates by ticker. Used to gate picks near events.</p>
        </div>
        <div className="flex gap-2 items-center">
          <span className="muted text-xs">Window</span>
          {[null, 7, 14, 30].map((d) => (
            <button
              key={String(d)}
              onClick={() => setWithin(d)}
              className={`px-2 py-1 text-xs rounded border ${within === d ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--border)] muted hover:text-white"}`}
            >
              {d == null ? "all" : `${d}d`}
            </button>
          ))}
        </div>
      </header>

      <Card title="Add or update">
        <UpsertForm onSubmit={upsert} busy={busy != null} />
        {formErr && <div className="mt-3 text-xs down">{formErr}</div>}
      </Card>

      {isLoading && <Loading label="Loading earnings" />}
      {error && <ErrorBox err={error} />}
      {data && data.rows.length === 0 && (
        <Empty title="No upcoming earnings" hint="Add a row above to track an upcoming report." />
      )}

      {data && data.rows.length > 0 && (
        <Card title={`${data.rows.length} rows`}>
          <div className="flex flex-wrap gap-2 text-xs mb-3">
            <button
              type="button"
              onClick={() => downloadBlob(
                earningsToCSV(data.rows),
                "text/csv;charset=utf-8",
                earningsFilename(within, "csv"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download the earnings calendar as CSV for spreadsheet analysis"
              data-testid="earnings-export-csv"
            >
              <DownloadSimple size={12} weight="bold" /> CSV
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(
                earningsToJSON(data.rows),
                "application/json;charset=utf-8",
                earningsFilename(within, "json"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download the earnings calendar as JSON"
              data-testid="earnings-export-json"
            >
              <DownloadSimple size={12} weight="bold" /> JSON
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left muted text-xs uppercase tracking-wide">
                <tr>
                  <th className="py-2 pr-3">Ticker</th>
                  <th className="py-2 pr-3">Next report</th>
                  <th className="py-2 pr-3">In</th>
                  <th className="py-2 pr-3">Confirmed</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.rows
                  .slice()
                  .sort((a, b) => a.next_report.localeCompare(b.next_report))
                  .map((r) => {
                    const d = daysUntil(r.next_report);
                    const tone = d == null ? "neutral" : d < 0 ? "down" : d <= 7 ? "warn" : "info";
                    return (
                      <tr key={r.ticker} className="border-t border-[var(--border)]">
                        <td className="py-2 pr-3 font-medium">
                          <Link href={`/ticker/${r.ticker}`} className="hover:text-[var(--accent)]">
                            {r.ticker}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 num">{r.next_report}</td>
                        <td className="py-2 pr-3">
                          <Badge tone={tone as "up" | "down" | "warn" | "info" | "neutral"}>
                            {d == null ? "n/a" : d < 0 ? `${Math.abs(d)}d ago` : `${d}d`}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3">
                          {r.confirmed ? (
                            <span className="inline-flex items-center gap-1 text-[var(--green)] text-xs">
                              <CheckCircle weight="duotone" size={14} /> yes
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 muted text-xs">
                              <Circle weight="duotone" size={14} /> no
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 muted text-xs">{r.source}</td>
                        <td className="py-2 pr-3 text-right">
                          <Button
                            variant="danger"
                            disabled={busy === r.ticker}
                            onClick={() => remove(r.ticker)}
                          >
                            <Trash weight="duotone" size={14} />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function UpsertForm({
  onSubmit,
  busy,
}: {
  onSubmit: (ticker: string, body: EarningsIn) => Promise<void>;
  busy: boolean;
}) {
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [source, setSource] = useState("manual");

  return (
    <form
      className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ticker.trim() || !date.trim()) return;
        await onSubmit(ticker.trim(), { next_report: date, confirmed, source });
        setTicker("");
        setDate("");
      }}
    >
      <Field label="Ticker">
        <Input
          required
          placeholder="AAPL"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
        />
      </Field>
      <Field label="Next report (YYYY-MM-DD)">
        <Input
          required
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <Field label="Source">
        <Input value={source} onChange={(e) => setSource(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm pb-2">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        Confirmed
      </label>
      <Button type="submit" disabled={busy}>
        <span className="inline-flex items-center gap-1">
          <FloppyDisk weight="duotone" size={14} /> Save
        </span>
      </Button>
    </form>
  );
}
