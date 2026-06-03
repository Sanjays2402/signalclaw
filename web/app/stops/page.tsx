"use client";
import { useEffect, useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd, fmtPct } from "@/components/ui";
import { api, swrFetcher, type StopRule, type StopRuleIn, type StopCheck } from "@/lib/api";
import { stopsToCSV, stopsToJSON, stopsFilename, filterStops } from "@/lib/stopsExport";
import {
  parseStopsUrlState,
  serializeStopsUrlState,
  STOPS_FILTER_DEFAULT,
  STOP_KIND_FILTERS,
  type StopKindUrl,
} from "@/lib/stopsUrl";
import { Shield, ShieldCheck, Trash, Plus, Target, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
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

const KINDS = [
  { v: "stop_loss", l: "stop loss" },
  { v: "take_profit", l: "take profit" },
  { v: "trailing", l: "trailing stop" },
];

function kindTone(k: string): "down" | "up" | "warn" | "neutral" {
  if (k === "stop_loss") return "down";
  if (k === "take_profit") return "up";
  if (k === "trailing") return "warn";
  return "neutral";
}

function fmtValue(kind: string, v: number): string {
  if (kind === "trailing") return fmtPct(v);
  return fmtUsd(v);
}

export default function StopsPage() {
  return (
    <AuthGate>
      <Stops />
    </AuthGate>
  );
}

function Stops() {
  const { data, error, isLoading } = useSWR<{ rules: StopRule[] }>("/stops", swrFetcher, { refreshInterval: 60000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<StopCheck | null>(null);

  // Filter state mirrors to /stops?q=...&kind=... so a teammate can land
  // on the same filtered view from a shared link.
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<StopKindUrl>(
    STOPS_FILTER_DEFAULT.kind,
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const s = parseStopsUrlState(globalThis.window.location.search);
    setQuery(s.query);
    setKindFilter(s.kind);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const qs = serializeStopsUrlState({ query, kind: kindFilter });
    const loc = globalThis.window.location;
    const next = qs ? `${loc.pathname}?${qs}` : loc.pathname;
    const current = loc.pathname + loc.search;
    if (next !== current) globalThis.window.history.replaceState(null, "", next);
  }, [hydrated, query, kindFilter]);

  const allRules = data?.rules ?? [];
  const visibleRules = useMemo(
    () => filterStops(allRules, { ticker: query, kind: kindFilter }),
    [allRules, query, kindFilter],
  );
  const filterActive =
    query.trim() !== "" || kindFilter !== STOPS_FILTER_DEFAULT.kind;

  async function onCreate(input: StopRuleIn) {
    setFormErr(null);
    setBusy("create");
    try {
      await api("/stops", { method: "POST", body: JSON.stringify(input) });
      await mutate("/stops");
    } catch (e: any) {
      setFormErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this stop rule?")) return;
    setBusy(id);
    try {
      await api(`/stops/${id}`, { method: "DELETE" });
      await mutate("/stops");
    } finally {
      setBusy(null);
    }
  }

  async function onCheck() {
    setBusy("check");
    try {
      const r = await api<StopCheck>("/stops/check", { method: "POST", body: "{}" });
      setLastCheck(r);
      await mutate("/stops");
    } catch (e: any) {
      setLastCheck(null);
      alert(`Check failed: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Shield weight="duotone" />
            Stops
          </h1>
          <p className="muted text-xs">Stop loss, take profit, and trailing rules across the portfolio.</p>
        </div>
        <Button variant="ghost" onClick={onCheck} disabled={busy === "check"}>
          <ShieldCheck weight="duotone" className="inline mr-1" />
          {busy === "check" ? "Checking" : "Run check"}
        </Button>
      </header>

      {lastCheck && (
        <Card title={`Last check (${lastCheck.checked} rules)`}>
          {lastCheck.events.length === 0 ? (
            <div className="text-sm muted">No triggers fired on the latest bar.</div>
          ) : (
            <ul className="text-sm space-y-1">
              {lastCheck.events.map((e, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Badge tone={kindTone(e.kind)}>{e.kind}</Badge>
                  <Link href={`/ticker/${e.ticker}`} className="mono hover:underline">{e.ticker}</Link>
                  <span className="muted text-xs">at</span>
                  <span className="num">{fmtUsd(e.trigger_price)}</span>
                  <span className="muted text-xs">vs ref {fmtUsd(e.reference_price)}</span>
                  <span className="muted text-xs">· {e.timestamp}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <CreateStopForm onSubmit={onCreate} busy={busy === "create"} err={formErr} />

      <Card title="Active rules">
        {error ? <ErrorBox err={error} /> :
          isLoading || !data ? <Loading /> :
            data.rules.length === 0 ? (
              <Empty title="No stop rules" hint="Add a stop loss, take profit, or trailing rule above." />
            ) : (
              <>
              <div className="flex flex-wrap items-end gap-3 mb-3">
                <Field label="Filter ticker">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value.slice(0, 64))}
                    placeholder="e.g. AAPL"
                    aria-label="Filter stops by ticker"
                    data-testid="stops-filter-q"
                  />
                </Field>
                <Field label="Kind">
                  <Select
                    value={kindFilter}
                    onChange={(e) => setKindFilter(e.target.value as StopKindUrl)}
                    aria-label="Filter stops by kind"
                    data-testid="stops-filter-kind"
                  >
                    {STOP_KIND_FILTERS.map((k) => (
                      <option key={k} value={k}>
                        {k === "all" ? "all" : k.replace("_", " ")}
                      </option>
                    ))}
                  </Select>
                </Field>
                {filterActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setKindFilter(STOPS_FILTER_DEFAULT.kind);
                    }}
                    className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)] uppercase tracking-widest font-semibold mono"
                    data-testid="stops-filter-clear"
                  >
                    Clear
                  </button>
                )}
                <span
                  className="text-[11px] muted mono"
                  data-testid="stops-filter-count"
                >
                  {visibleRules.length} of {allRules.length}
                </span>
              </div>
              <div className="flex flex-wrap gap-2 text-xs mb-3">
                <button
                  type="button"
                  onClick={() => downloadBlob(
                    stopsToCSV(visibleRules),
                    "text/csv;charset=utf-8",
                    stopsFilename("csv"),
                  )}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
                  title="Download active stop rules as CSV for spreadsheet import"
                  data-testid="stops-export-csv"
                >
                  <DownloadSimple size={12} weight="bold" /> CSV
                </button>
                <button
                  type="button"
                  onClick={() => downloadBlob(
                    stopsToJSON(visibleRules),
                    "application/json;charset=utf-8",
                    stopsFilename("json"),
                  )}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
                  title="Download active stop rules as JSON for scripting or backup"
                  data-testid="stops-export-json"
                >
                  <DownloadSimple size={12} weight="bold" /> JSON
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                      <th className="py-2 pr-3">Ticker</th>
                      <th className="pr-3">Kind</th>
                      <th className="text-right pr-3">Value</th>
                      <th className="text-right pr-3">High water</th>
                      <th className="pr-3">Armed</th>
                      <th className="pr-3">Note</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRules.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="py-4 text-xs muted text-center">
                          No rules match the current filter.
                        </td>
                      </tr>
                    ) : null}
                    {visibleRules.map((r) => (
                      <tr key={r.id} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                        <td className="py-2 pr-3">
                          <Link href={`/ticker/${r.ticker}`} className="mono hover:underline">{r.ticker}</Link>
                        </td>
                        <td className="pr-3">
                          <Badge tone={kindTone(r.kind)}>{r.kind}</Badge>
                        </td>
                        <td className="num text-right pr-3">{fmtValue(r.kind, r.value)}</td>
                        <td className="num text-right pr-3">{r.high_water != null ? fmtUsd(r.high_water) : "..."}</td>
                        <td className="pr-3 text-xs muted">{r.armed_at}</td>
                        <td className="pr-3 text-xs muted">{r.note || ""}</td>
                        <td>
                          <Button
                            variant="danger"
                            onClick={() => onDelete(r.id)}
                            disabled={busy === r.id}
                            className="text-xs"
                          >
                            <Trash weight="duotone" className="inline" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
      </Card>
    </div>
  );
}

function CreateStopForm({
  onSubmit,
  busy,
  err,
}: {
  onSubmit: (a: StopRuleIn) => void;
  busy: boolean;
  err: string | null;
}) {
  const [ticker, setTicker] = useState("");
  const [kind, setKind] = useState("stop_loss");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const raw = parseFloat(value);
    if (!ticker || Number.isNaN(raw)) return;
    const v = kind === "trailing" ? raw / 100 : raw;
    onSubmit({
      ticker: ticker.toUpperCase().trim(),
      kind,
      value: v,
      note: note.trim(),
    });
    setValue("");
    setNote("");
  }

  return (
    <Card title="New rule">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}
          </Select>
        </Field>
        <Field label={kind === "trailing" ? "Trail (%)" : "Price ($)"}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="duotone" className="inline mr-1" />
          {busy ? "Saving" : <span className="inline-flex items-center gap-1"><Target weight="duotone" /> Arm</span>}
        </Button>
        {err && <div className="md:col-span-5 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}
