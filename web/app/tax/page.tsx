"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import AuthGate from "@/components/AuthGate";
import Link from "next/link";
import {
  Card, Stat, Badge, Loading, ErrorBox, Empty, Field, Select, Input, Button,
  fmtUsd,
} from "@/components/ui";
import { swrFetcher, type TaxReport } from "@/lib/api";
import { taxEventsToCSV, taxReportToJSON, taxFilename } from "@/lib/taxExport";
import {
  parseTaxUrlState,
  serializeTaxUrlState,
  tickerMatchesTaxQuery,
} from "@/lib/taxUrl";
import { Receipt, Warning, DownloadSimple } from "@phosphor-icons/react/dist/ssr";

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

const METHODS = ["fifo", "lifo", "hifo", "avgco"] as const;

export default function Page() {
  return (
    <AuthGate>
      <Tax />
    </AuthGate>
  );
}

function Tax() {
  const [method, setMethod] = useState<(typeof METHODS)[number]>("fifo");
  const [washWindow, setWashWindow] = useState(30);
  const [applied, setApplied] = useState({ method: "fifo", wash_window: 30 });
  // Ticker filter mirrors to /tax?q=... so a shared link lands a teammate
  // on the same filtered view of realized events and wash sales.
  const [query, setQuery] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const s = parseTaxUrlState(globalThis.window.location.search);
    setQuery(s.query);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const qs = serializeTaxUrlState({ query });
    const loc = globalThis.window.location;
    const next = qs ? `${loc.pathname}?${qs}` : loc.pathname;
    const current = loc.pathname + loc.search;
    if (next !== current) globalThis.window.history.replaceState(null, "", next);
  }, [hydrated, query]);

  const key = `/portfolio/tax?method=${applied.method}&wash_window=${applied.wash_window}`;
  const { data, error, isLoading, mutate } = useSWR<TaxReport>(key, swrFetcher);

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Receipt weight="duotone" size={22} className="text-[var(--accent)]" />
            Tax
          </h1>
          <p className="muted text-xs">
            Realized gains and wash sale flags computed from your trade log.
          </p>
        </div>
      </header>

      <Card title="Lot method">
        <form
          className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ method, wash_window: washWindow });
            mutate();
          }}
        >
          <Field label="Method">
            <Select value={method} onChange={(e) => setMethod(e.target.value as typeof METHODS[number])}>
              {METHODS.map((m) => (
                <option key={m} value={m}>{m.toUpperCase()}</option>
              ))}
            </Select>
          </Field>
          <Field label="Wash sale window (days)">
            <Input
              type="number" min={0} max={365}
              value={washWindow}
              onChange={(e) => setWashWindow(Number(e.target.value) || 0)}
            />
          </Field>
          <div className="md:col-span-2 flex gap-2">
            <Button type="submit">Apply</Button>
            <Button type="button" variant="ghost" onClick={() => mutate()}>Refresh</Button>
          </div>
        </form>
      </Card>

      <Card title="Filter">
        <Field label="Ticker contains">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 64))}
            placeholder="e.g. AAPL"
            spellCheck={false}
            autoCapitalize="characters"
            data-testid="tax-ticker-filter"
          />
        </Field>
        <p className="muted text-xs mt-2">
          Filters realized events, wash sales, and the CSV/JSON downloads below.
          The query mirrors to the URL so you can share the filtered view.
        </p>
      </Card>

      {error ? <ErrorBox err={error} /> :
        isLoading || !data ? <Loading label="Computing tax report" /> :
        <Report data={data} washWindow={applied.wash_window} query={query} />}
    </div>
  );
}

function Report({ data, washWindow, query }: { data: TaxReport; washWindow: number; query: string }) {
  const filteredEvents = useMemo(
    () => data.events.filter((e) => tickerMatchesTaxQuery(e.ticker, query)),
    [data.events, query],
  );
  const filteredWashSales = useMemo(
    () => data.wash_sales.filter((w) => tickerMatchesTaxQuery(w.ticker, query)),
    [data.wash_sales, query],
  );
  // Downloads honour the active filter so the spreadsheet matches the screen.
  const filteredReport = useMemo(
    () => ({ ...data, events: filteredEvents, wash_sales: filteredWashSales }),
    [data, filteredEvents, filteredWashSales],
  );
  const hasFilter = query.trim().length > 0;
  const totalTone = data.realized_total >= 0 ? "up" : "down";
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Realized total" value={fmtUsd(data.realized_total)} tone={totalTone} />
        <Stat label="Short term"
          value={fmtUsd(data.realized_short_term)}
          tone={data.realized_short_term >= 0 ? "up" : "down"} />
        <Stat label="Long term"
          value={fmtUsd(data.realized_long_term)}
          tone={data.realized_long_term >= 0 ? "up" : "down"} />
        <Stat label="Wash sales" value={String(data.wash_sales.length)}
          tone={data.wash_sales.length > 0 ? "down" : "neutral"} />
      </div>

      <Card title={`Realized events (${data.method.toUpperCase()})${hasFilter ? ` (${filteredEvents.length} of ${data.events.length})` : ""}`}>
        {data.events.length === 0 ? (
          <Empty title="No realized events" hint="Close some positions to see lot accounting here." />
        ) : filteredEvents.length === 0 ? (
          <Empty title="No events match the filter" hint={`Clear the ticker filter to see all ${data.events.length} events.`} />
        ) : (
          <>
          <div className="flex flex-wrap gap-2 text-xs mb-3">
            <button
              type="button"
              onClick={() => downloadBlob(
                taxEventsToCSV(filteredEvents),
                "text/csv;charset=utf-8",
                taxFilename(data.method, washWindow, "csv"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download realized events as CSV for spreadsheet or tax software import"
              data-testid="tax-export-csv"
            >
              <DownloadSimple size={12} weight="bold" /> CSV
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(
                taxReportToJSON(filteredReport),
                "application/json;charset=utf-8",
                taxFilename(data.method, washWindow, "json"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download the full tax report (totals, events, wash sales) as JSON"
              data-testid="tax-export-json"
            >
              <DownloadSimple size={12} weight="bold" /> JSON
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left muted text-xs uppercase tracking-wide border-b border-[var(--border)]">
                  <th className="py-2 pr-3">Date</th>
                  <th className="pr-3">Ticker</th>
                  <th className="text-right pr-3">Qty</th>
                  <th className="text-right pr-3">Proceeds</th>
                  <th className="text-right pr-3">Cost</th>
                  <th className="text-right pr-3">PnL</th>
                  <th className="pr-3">Held</th>
                  <th>Lot acquired</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((e, i) => (
                  <tr key={`${e.sell_trade_id}-${i}`} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                    <td className="py-2 pr-3 mono text-xs">{e.sell_date.slice(0, 10)}</td>
                    <td className="pr-3 mono">
                      <Link href={`/ticker/${e.ticker}`} className="hover:text-[var(--accent)]">
                        {e.ticker}
                      </Link>
                    </td>
                    <td className="num text-right pr-3">{e.quantity.toFixed(4)}</td>
                    <td className="num text-right pr-3">{fmtUsd(e.proceeds)}</td>
                    <td className="num text-right pr-3">{fmtUsd(e.cost_basis)}</td>
                    <td className={`num text-right pr-3 ${e.realized_pnl >= 0 ? "up" : "down"}`}>
                      {fmtUsd(e.realized_pnl)}
                    </td>
                    <td className="pr-3 text-xs">
                      {e.holding_days != null ? (
                        <Badge tone={e.long_term ? "info" : "warn"}>
                          {e.holding_days}d {e.long_term ? "LT" : "ST"}
                        </Badge>
                      ) : (
                        <span className="muted">n/a</span>
                      )}
                    </td>
                    <td className="muted text-xs mono">{e.lot_acquired ?? "avg cost"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      <Card title={`Wash sales${hasFilter ? ` (${filteredWashSales.length} of ${data.wash_sales.length})` : ""}`}>
        {data.wash_sales.length === 0 ? (
          <Empty title="No wash sales flagged" hint={`Within a ${data.events.length > 0 ? "configured" : ""} ${"\u00B1"}window around each loss.`} />
        ) : filteredWashSales.length === 0 ? (
          <Empty title="No wash sales match the filter" hint={`Clear the ticker filter to see all ${data.wash_sales.length} flagged sales.`} />
        ) : (
          <div className="space-y-2">
            {filteredWashSales.map((w, i) => (
              <div key={i} className="panel p-3 flex flex-wrap items-center gap-3 text-sm">
                <Warning weight="duotone" size={18} className="text-[var(--amber)]" />
                <span className="mono">{w.ticker}</span>
                <span className="muted text-xs">sold {w.sell_date.slice(0, 10)}</span>
                <span className="down num">{fmtUsd(w.loss)}</span>
                <span className="muted text-xs">replaced by buy {w.triggering_buy_date.slice(0, 10)}</span>
                <Badge tone="warn">{w.days_between}d apart</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="muted text-xs">
        Tax estimates are informational only. Consult a tax professional before filing.
      </p>
    </>
  );
}
