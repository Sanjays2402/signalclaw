"use client";
import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Stat, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd, fmtPct } from "@/components/ui";
import { api, swrFetcher, type JournalEntry, type JournalEntryIn } from "@/lib/api";
import { Notebook, Plus, Trash, DownloadSimple, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { entriesToCSV, entriesToJSON, exportFilename, filterEntries } from "@/lib/journalExport";

type ConvictionStats = {
  buckets: { conviction: number; n_trades: number; realized_pnl: number; avg_realized_pnl: number; win_rate: number }[];
};

export default function JournalPage() {
  return (
    <AuthGate>
      <Journal />
    </AuthGate>
  );
}

function Journal() {
  const list = useSWR<{ entries: JournalEntry[] }>("/journal", swrFetcher);
  const stats = useSWR<ConvictionStats>("/journal/stats/conviction", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [convFilter, setConvFilter] = useState<"" | "1" | "2" | "3" | "4" | "5">("");

  const allEntries = list.data?.entries ?? [];
  const filtered = useMemo(
    () => filterEntries(allEntries, {
      query,
      conviction: convFilter === "" ? null : parseInt(convFilter, 10),
    }),
    [allEntries, query, convFilter],
  );

  async function refresh() {
    await Promise.all([mutate("/journal"), mutate("/journal/stats/conviction")]);
  }

  async function onCreate(input: JournalEntryIn) {
    setErr(null);
    setBusy("create");
    try {
      await api("/journal", { method: "POST", body: JSON.stringify(input) });
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm(`Delete journal entry for ${id}?`)) return;
    setBusy(id);
    try {
      await api(`/journal/${id}`, { method: "DELETE" });
      await refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Notebook weight="duotone" />
            Journal
          </h1>
          <p className="muted text-xs">Thesis, conviction, and tags per trade.</p>
        </div>
        <ExportButtons entries={filtered} />
      </header>

      <ConvictionStatsRow s={stats.data} err={stats.error} />
      <CreateForm onSubmit={onCreate} busy={busy === "create"} err={err} />

      <Card title="Entries">
        {list.error ? <ErrorBox err={list.error} /> :
          !list.data ? <Loading /> :
            allEntries.length === 0 ? (
              <Empty title="No journal entries yet" hint="Log your thesis on each trade to grade your edge." />
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap pb-3 mb-3 border-b border-[var(--border)]">
                  <div className="relative flex-1 min-w-[200px]">
                    <MagnifyingGlass weight="duotone" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 opacity-60 pointer-events-none" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search trade id, thesis, tags, exit reason"
                      className="pl-7"
                      data-testid="journal-filter-query"
                    />
                  </div>
                  <Select
                    value={convFilter}
                    onChange={(e) => setConvFilter(e.target.value as typeof convFilter)}
                    data-testid="journal-filter-conviction"
                    title="Filter by conviction"
                  >
                    <option value="">All conviction</option>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={String(n)}>Conviction {n}</option>
                    ))}
                  </Select>
                  <span className="muted text-xs mono" data-testid="journal-filter-count">
                    {filtered.length}/{allEntries.length}
                  </span>
                  {(query || convFilter) && (
                    <button
                      type="button"
                      className="text-[10px] uppercase tracking-widest mono px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)]"
                      onClick={() => { setQuery(""); setConvFilter(""); }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {filtered.length === 0 ? (
                  <Empty title="No entries match" hint="Try clearing the filter or widening your search." />
                ) : (
                <ul className="divide-y divide-[var(--border)]">
                {filtered.map((e) => (
                  <li key={e.trade_id} className="py-3 flex items-start gap-3">
                    <div className="shrink-0 w-24">
                      <div className="mono text-sm">{e.trade_id}</div>
                      <div className="muted text-xs">{e.updated_at?.slice(0, 10)}</div>
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge tone={e.conviction >= 4 ? "up" : e.conviction <= 2 ? "warn" : "info"}>
                          conviction {e.conviction}/5
                        </Badge>
                        {e.exit_reason && <Badge tone="neutral">{e.exit_reason}</Badge>}
                        {e.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}
                      </div>
                      <p className="text-sm">{e.thesis || <span className="muted">(no thesis)</span>}</p>
                    </div>
                    <Button variant="danger" className="text-xs" onClick={() => onDelete(e.trade_id)} disabled={busy === e.trade_id}>
                      <Trash weight="duotone" />
                    </Button>
                  </li>
                ))}
              </ul>
                )}
              </>
            )}
      </Card>
    </div>
  );
}

function ExportButtons({ entries }: { entries: JournalEntry[] }) {
  const disabled = entries.length === 0;
  function download(ext: "csv" | "json") {
    const body = ext === "csv" ? entriesToCSV(entries) : entriesToJSON(entries);
    const mime = ext === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const cls =
    "text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-sm border border-[var(--border)] hover:border-[var(--accent)] uppercase tracking-widest font-semibold mono" +
    (disabled ? " opacity-40 pointer-events-none" : "");
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => download("csv")}
        disabled={disabled}
        className={cls}
        title="Download journal entries as CSV"
        data-testid="journal-export-csv"
      >
        <DownloadSimple weight="duotone" size={11} /> CSV
      </button>
      <button
        type="button"
        onClick={() => download("json")}
        disabled={disabled}
        className={cls}
        title="Download journal entries as JSON"
        data-testid="journal-export-json"
      >
        <DownloadSimple weight="duotone" size={11} /> JSON
      </button>
    </div>
  );
}

function ConvictionStatsRow({ s, err }: { s?: ConvictionStats; err: unknown }) {
  if (err) return <ErrorBox err={err} />;
  if (!s) return <Loading label="Loading conviction stats" />;
  if (s.buckets.length === 0) {
    return <Empty title="No conviction data yet" hint="Log entries with conviction to track edge by confidence." />;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {s.buckets.map((b) => (
        <Stat
          key={b.conviction}
          label={`Conviction ${b.conviction}`}
          tone={b.avg_realized_pnl >= 0 ? "up" : "down"}
          value={fmtUsd(b.avg_realized_pnl)}
          delta={`${b.n_trades} trades, win ${fmtPct(b.win_rate)}`}
        />
      ))}
    </div>
  );
}

function CreateForm({
  onSubmit, busy, err,
}: { onSubmit: (e: JournalEntryIn) => void; busy: boolean; err: string | null }) {
  const [tradeId, setTradeId] = useState("");
  const [thesis, setThesis] = useState("");
  const [conviction, setConviction] = useState(3);
  const [tags, setTags] = useState("");
  const [exitReason, setExitReason] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!tradeId.trim()) return;
    onSubmit({
      trade_id: tradeId.trim(),
      thesis: thesis.trim(),
      conviction,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      exit_reason: exitReason.trim() || null,
    });
    setTradeId(""); setThesis(""); setTags(""); setExitReason(""); setConviction(3);
  }

  return (
    <Card title="Log a trade">
      <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <Field label="Trade ID">
          <Input value={tradeId} onChange={(e) => setTradeId(e.target.value)} placeholder="trade UUID" required />
        </Field>
        <Field label="Conviction">
          <Select value={conviction} onChange={(e) => setConviction(parseInt(e.target.value, 10))}>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
        <Field label="Tags (comma)">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="breakout, earnings" />
        </Field>
        <Field label="Exit reason">
          <Input value={exitReason} onChange={(e) => setExitReason(e.target.value)} placeholder="optional" />
        </Field>
        <Field label="Thesis">
          <Input value={thesis} onChange={(e) => setThesis(e.target.value)} placeholder="why are you in this trade?" />
        </Field>
        <Button type="submit" disabled={busy}>
          <Plus weight="duotone" className="inline mr-1" />
          {busy ? "Saving" : "Log"}
        </Button>
        {err && <div className="md:col-span-6 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}
