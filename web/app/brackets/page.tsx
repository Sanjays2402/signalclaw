"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import { Card, Stat, Badge, Loading, ErrorBox, Empty, Button, Input, Select, Field, fmtUsd, fmtPct } from "@/components/ui";
import { api, swrFetcher, type Bracket, type BracketIn, type BracketStats } from "@/lib/api";
import { Target, ArrowsClockwise, Trash, Plus, CheckCircle, X } from "@phosphor-icons/react/dist/ssr";

export default function BracketsPage() {
  return (
    <AuthGate>
      <Brackets />
    </AuthGate>
  );
}

function statusTone(s: string): "up" | "down" | "warn" | "info" | "neutral" {
  if (s === "filled" || s === "open") return "info";
  if (s === "closed_win") return "up";
  if (s === "closed_loss") return "down";
  if (s === "cancelled") return "neutral";
  return "warn";
}

function Brackets() {
  const list = useSWR<{ plans: Bracket[] }>("/brackets", swrFetcher);
  const stats = useSWR<BracketStats>("/brackets/stats", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([mutate("/brackets"), mutate("/brackets/stats")]);
  }

  async function onCreate(input: BracketIn) {
    setErr(null);
    setBusy("create");
    try {
      await api("/brackets", { method: "POST", body: JSON.stringify(input) });
      await refresh();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onFill(id: string) {
    const v = prompt("Actual entry price?");
    if (!v) return;
    setBusy(id);
    try {
      await api(`/brackets/${id}/fill`, { method: "POST", body: JSON.stringify({ actual_entry: parseFloat(v) }) });
      await refresh();
    } catch (e: any) { alert(e?.message ?? e); }
    finally { setBusy(null); }
  }

  async function onClose(id: string) {
    const v = prompt("Actual exit price?");
    if (!v) return;
    const reason = prompt("Reason (target|stop|manual)?", "manual") || "manual";
    setBusy(id);
    try {
      await api(`/brackets/${id}/close`, { method: "POST", body: JSON.stringify({ actual_exit: parseFloat(v), reason }) });
      await refresh();
    } catch (e: any) { alert(e?.message ?? e); }
    finally { setBusy(null); }
  }

  async function onCancel(id: string) {
    if (!confirm("Cancel this plan?")) return;
    setBusy(id);
    try {
      await api(`/brackets/${id}/cancel`, { method: "POST", body: "{}" });
      await refresh();
    } catch (e: any) { alert(e?.message ?? e); }
    finally { setBusy(null); }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete plan?")) return;
    setBusy(id);
    try {
      await api(`/brackets/${id}`, { method: "DELETE" });
      await refresh();
    } finally { setBusy(null); }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Target weight="duotone" />
            Brackets
          </h1>
          <p className="muted text-xs">Entry, stop, and target plans with realized R stats.</p>
        </div>
        <Button variant="ghost" onClick={refresh}>
          <ArrowsClockwise weight="duotone" className="inline mr-1" /> Refresh
        </Button>
      </header>

      <StatsRow s={stats.data} err={stats.error} />
      <CreateBracketForm onSubmit={onCreate} busy={busy === "create"} err={err} />

      <Card title="Plans">
        {list.error ? <ErrorBox err={list.error} /> :
          !list.data ? <Loading /> :
            list.data.plans.length === 0 ? (
              <Empty title="No bracket plans" hint="Create one above to start tracking risk." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left muted text-xs uppercase border-b border-[var(--border)]">
                      <th className="py-2 pr-3">Ticker</th>
                      <th className="pr-3">Side</th>
                      <th className="text-right pr-3">Shares</th>
                      <th className="text-right pr-3">Entry</th>
                      <th className="text-right pr-3">Stop</th>
                      <th className="text-right pr-3">Target</th>
                      <th className="text-right pr-3">R plan</th>
                      <th className="text-right pr-3">Risk $</th>
                      <th className="pr-3">Status</th>
                      <th className="text-right pr-3">Realized R</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.plans.map((b) => (
                      <tr key={b.id} className="border-b border-[var(--border)] hover:bg-white/[0.02]">
                        <td className="py-2 pr-3 mono">{b.ticker}</td>
                        <td className="pr-3 text-xs">{b.side}</td>
                        <td className="num text-right pr-3">{b.shares}</td>
                        <td className="num text-right pr-3">{fmtUsd(b.entry)}</td>
                        <td className="num text-right pr-3 down">{fmtUsd(b.stop)}</td>
                        <td className="num text-right pr-3 up">{fmtUsd(b.target)}</td>
                        <td className="num text-right pr-3">{b.planned_r_multiple.toFixed(2)}R</td>
                        <td className="num text-right pr-3">{fmtUsd(b.planned_risk_dollars)}</td>
                        <td className="pr-3">
                          <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                        </td>
                        <td className={`num text-right pr-3 ${(b.realized_r ?? 0) >= 0 ? "up" : "down"}`}>
                          {b.realized_r == null ? "n/a" : `${b.realized_r.toFixed(2)}R`}
                        </td>
                        <td className="flex gap-1 py-2">
                          {b.status === "open" && (
                            <Button variant="ghost" className="text-xs" onClick={() => onFill(b.id)} disabled={busy === b.id}>
                              <CheckCircle weight="duotone" /> fill
                            </Button>
                          )}
                          {b.status === "filled" && (
                            <Button variant="ghost" className="text-xs" onClick={() => onClose(b.id)} disabled={busy === b.id}>
                              <CheckCircle weight="duotone" /> close
                            </Button>
                          )}
                          {(b.status === "open" || b.status === "filled") && (
                            <Button variant="ghost" className="text-xs" onClick={() => onCancel(b.id)} disabled={busy === b.id}>
                              <X weight="duotone" />
                            </Button>
                          )}
                          <Button variant="danger" className="text-xs" onClick={() => onDelete(b.id)} disabled={busy === b.id}>
                            <Trash weight="duotone" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Card>
    </div>
  );
}

function StatsRow({ s, err }: { s?: BracketStats; err: unknown }) {
  if (err) return <ErrorBox err={err} />;
  if (!s) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => <div key={i} className="panel p-4 h-20 animate-pulse" />)}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Stat label="Total" value={s.total} delta={`${s.open} open, ${s.filled} filled`} />
      <Stat label="Win rate" tone={s.win_rate >= 0.5 ? "up" : "down"} value={fmtPct(s.win_rate)} />
      <Stat label="Avg R" tone={s.avg_r >= 0 ? "up" : "down"} value={`${s.avg_r.toFixed(2)}R`} />
      <Stat label="Median R" tone={s.median_r >= 0 ? "up" : "down"} value={`${s.median_r.toFixed(2)}R`} />
      <Stat label="Expectancy" tone={s.expectancy >= 0 ? "up" : "down"} value={`${s.expectancy.toFixed(2)}R`} />
    </div>
  );
}

function CreateBracketForm({
  onSubmit, busy, err,
}: { onSubmit: (b: BracketIn) => void; busy: boolean; err: string | null }) {
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState("long");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [shares, setShares] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const e_ = parseFloat(entry), s_ = parseFloat(stop), t_ = parseFloat(target), sh_ = parseInt(shares, 10);
    if (!ticker || [e_, s_, t_, sh_].some((n) => Number.isNaN(n))) return;
    onSubmit({
      ticker: ticker.toUpperCase().trim(), side,
      entry: e_, stop: s_, target: t_, shares: sh_, note: note.trim(),
    });
  }

  const risk = parseFloat(entry) && parseFloat(stop) ? Math.abs(parseFloat(entry) - parseFloat(stop)) : 0;
  const reward = parseFloat(entry) && parseFloat(target) ? Math.abs(parseFloat(target) - parseFloat(entry)) : 0;
  const r = risk > 0 ? reward / risk : 0;

  return (
    <Card title="New bracket">
      <form onSubmit={submit} className="grid grid-cols-2 md:grid-cols-7 gap-3 items-end">
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label="Side">
          <Select value={side} onChange={(e) => setSide(e.target.value)}>
            <option value="long">long</option>
            <option value="short">short</option>
          </Select>
        </Field>
        <Field label="Entry"><Input value={entry} onChange={(e) => setEntry(e.target.value)} type="number" step="any" required /></Field>
        <Field label="Stop"><Input value={stop} onChange={(e) => setStop(e.target.value)} type="number" step="any" required /></Field>
        <Field label="Target"><Input value={target} onChange={(e) => setTarget(e.target.value)} type="number" step="any" required /></Field>
        <Field label="Shares"><Input value={shares} onChange={(e) => setShares(e.target.value)} type="number" min={1} required /></Field>
        <div className="flex flex-col gap-1">
          <div className="muted text-xs">Plan R: <span className="num text-white">{r.toFixed(2)}</span></div>
          <Button type="submit" disabled={busy}>
            <Plus weight="duotone" className="inline mr-1" />
            {busy ? "Saving" : "Create"}
          </Button>
        </div>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional thesis tag" /></Field>
        {err && <div className="md:col-span-7 text-xs down">{err}</div>}
      </form>
    </Card>
  );
}
