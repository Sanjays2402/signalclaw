"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import AuthGate from "@/components/AuthGate";
import RuleVisual from "@/components/RuleVisual";
import {
  Card,
  Stat,
  Badge,
  Loading,
  ErrorBox,
  Empty,
  Button,
  Input,
  Select,
  Field,
  fmtUsd,
  fmtPct,
  colorOf,
} from "@/components/ui";
import { api, swrFetcher, type Bracket, type BracketIn, type BracketStats } from "@/lib/api";
import { bracketsToCSV, bracketsToJSON, bracketsFilename } from "@/lib/bracketsExport";
import { ArrowsClockwise, Trash, Plus, CheckCircle, X, DownloadSimple } from "@phosphor-icons/react/dist/ssr";

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
      await api(`/brackets/${id}/fill`, {
        method: "POST",
        body: JSON.stringify({ actual_entry: parseFloat(v) }),
      });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? e);
    } finally {
      setBusy(null);
    }
  }

  async function onClose(id: string) {
    const v = prompt("Actual exit price?");
    if (!v) return;
    const reason = prompt("Reason (target|stop|manual)?", "manual") || "manual";
    setBusy(id);
    try {
      await api(`/brackets/${id}/close`, {
        method: "POST",
        body: JSON.stringify({ actual_exit: parseFloat(v), reason }),
      });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? e);
    } finally {
      setBusy(null);
    }
  }

  async function onCancel(id: string) {
    if (!confirm("Cancel this plan?")) return;
    setBusy(id);
    try {
      await api(`/brackets/${id}/cancel`, { method: "POST", body: "{}" });
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? e);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete plan?")) return;
    setBusy(id);
    try {
      await api(`/brackets/${id}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-7xl mx-auto space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-base font-semibold uppercase tracking-widest">Brackets</h1>
          <p className="muted text-[10px] uppercase tracking-widest">
            Entry / stop / target. R stats live below.
          </p>
        </div>
        <Button variant="ghost" onClick={refresh}>
          <ArrowsClockwise weight="duotone" className="inline mr-1" size={11} /> Refresh
        </Button>
      </header>

      <StatsRow s={stats.data} err={stats.error} />
      <CreateBracketForm onSubmit={onCreate} busy={busy === "create"} err={err} />

      <Card title="Plans">
        {list.error ? (
          <ErrorBox err={list.error} />
        ) : !list.data ? (
          <Loading />
        ) : list.data.plans.length === 0 ? (
          <Empty title="No bracket plans" hint="Create one above to start tracking R." />
        ) : (
          <>
          <div className="flex flex-wrap gap-2 text-xs mb-3">
            <button
              type="button"
              onClick={() => downloadBlob(
                bracketsToCSV(list.data.plans),
                "text/csv;charset=utf-8",
                bracketsFilename("csv"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download bracket plans as CSV for spreadsheet import"
              data-testid="brackets-export-csv"
            >
              <DownloadSimple size={12} weight="bold" /> CSV
            </button>
            <button
              type="button"
              onClick={() => downloadBlob(
                bracketsToJSON(list.data.plans),
                "application/json;charset=utf-8",
                bracketsFilename("json"),
              )}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
              title="Download bracket plans as JSON for scripting or backup"
              data-testid="brackets-export-json"
            >
              <DownloadSimple size={12} weight="bold" /> JSON
            </button>
          </div>
          <div className="overflow-x-auto -mx-3">
            <table className="trade">
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Side</th>
                  <th className="r">Shares</th>
                  <th style={{ width: 260 }}>Plan</th>
                  <th className="r">Stop</th>
                  <th className="r">Entry</th>
                  <th className="r">Target</th>
                  <th className="r">R</th>
                  <th className="r">Risk $</th>
                  <th>Status</th>
                  <th className="r">Real R</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.plans.map((b) => (
                  <tr key={b.id}>
                    <td className="mono font-semibold">{b.ticker}</td>
                    <td>
                      <Badge tone={b.side === "long" ? "up" : "down"}>{b.side}</Badge>
                    </td>
                    <td className="r mono">{b.shares}</td>
                    <td>
                      <RuleVisual
                        kind="bracket"
                        side={b.side}
                        entry={b.entry}
                        stop={b.stop}
                        target={b.target}
                        current={b.actual_entry ?? null}
                      />
                    </td>
                    <td className="r mono down">{fmtUsd(b.stop)}</td>
                    <td className="r mono warn">{fmtUsd(b.entry)}</td>
                    <td className="r mono up">{fmtUsd(b.target)}</td>
                    <td className="r mono">{b.planned_r_multiple.toFixed(2)}</td>
                    <td className="r mono down">{fmtUsd(b.planned_risk_dollars)}</td>
                    <td>
                      <Badge tone={statusTone(b.status)}>{b.status.replace("_", " ")}</Badge>
                    </td>
                    <td className={`r mono ${colorOf(b.realized_r)}`}>
                      {b.realized_r == null ? "--" : `${b.realized_r >= 0 ? "+" : ""}${b.realized_r.toFixed(2)}R`}
                    </td>
                    <td className="flex gap-1 py-1">
                      {b.status === "open" && (
                        <Button
                          variant="ghost"
                          className="text-[10px]"
                          onClick={() => onFill(b.id)}
                          disabled={busy === b.id}
                        >
                          <CheckCircle weight="duotone" size={11} /> fill
                        </Button>
                      )}
                      {b.status === "filled" && (
                        <Button
                          variant="ghost"
                          className="text-[10px]"
                          onClick={() => onClose(b.id)}
                          disabled={busy === b.id}
                        >
                          <CheckCircle weight="duotone" size={11} /> close
                        </Button>
                      )}
                      {(b.status === "open" || b.status === "filled") && (
                        <Button
                          variant="ghost"
                          className="text-[10px]"
                          onClick={() => onCancel(b.id)}
                          disabled={busy === b.id}
                        >
                          <X weight="duotone" size={11} />
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        className="text-[10px]"
                        onClick={() => onDelete(b.id)}
                        disabled={busy === b.id}
                      >
                        <Trash weight="duotone" size={11} />
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

function StatsRow({ s, err }: { s?: BracketStats; err: unknown }) {
  if (err) return <ErrorBox err={err} />;
  if (!s) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="panel p-4 h-20 animate-pulse" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Stat label="Total" value={s.total} delta={`${s.open} open · ${s.filled} live`} />
      <Stat label="Win rate" tone={s.win_rate >= 0.5 ? "up" : "down"} value={fmtPct(s.win_rate)} />
      <Stat label="Avg R" tone={colorOf(s.avg_r) as any} value={`${s.avg_r >= 0 ? "+" : ""}${s.avg_r.toFixed(2)}R`} />
      <Stat label="Med R" tone={colorOf(s.median_r) as any} value={`${s.median_r >= 0 ? "+" : ""}${s.median_r.toFixed(2)}R`} />
      <Stat
        label="Expectancy"
        tone={colorOf(s.expectancy) as any}
        value={`${s.expectancy >= 0 ? "+" : ""}${s.expectancy.toFixed(2)}R`}
      />
    </div>
  );
}

function CreateBracketForm({
  onSubmit,
  busy,
  err,
}: {
  onSubmit: (b: BracketIn) => void;
  busy: boolean;
  err: string | null;
}) {
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState("long");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [shares, setShares] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const e_ = parseFloat(entry),
      s_ = parseFloat(stop),
      t_ = parseFloat(target),
      sh_ = parseInt(shares, 10);
    if (!ticker || [e_, s_, t_, sh_].some((n) => Number.isNaN(n))) return;
    onSubmit({
      ticker: ticker.toUpperCase().trim(),
      side,
      entry: e_,
      stop: s_,
      target: t_,
      shares: sh_,
      note: note.trim(),
    });
  }

  const e_ = parseFloat(entry),
    s_ = parseFloat(stop),
    t_ = parseFloat(target);
  const valid = [e_, s_, t_].every(Number.isFinite);
  const risk = valid ? Math.abs(e_ - s_) : 0;
  const reward = valid ? Math.abs(t_ - e_) : 0;
  const r = risk > 0 ? reward / risk : 0;

  return (
    <Card title="New bracket">
      <form onSubmit={submit} className="grid grid-cols-2 md:grid-cols-8 gap-3 items-end">
        <Field label="Ticker">
          <Input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="AAPL" required />
        </Field>
        <Field label="Side">
          <Select value={side} onChange={(e) => setSide(e.target.value)}>
            <option value="long">long</option>
            <option value="short">short</option>
          </Select>
        </Field>
        <Field label="Entry">
          <Input value={entry} onChange={(e) => setEntry(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Stop">
          <Input value={stop} onChange={(e) => setStop(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Target">
          <Input value={target} onChange={(e) => setTarget(e.target.value)} type="number" step="any" required />
        </Field>
        <Field label="Shares">
          <Input value={shares} onChange={(e) => setShares(e.target.value)} type="number" min={1} required />
        </Field>
        <div className="flex flex-col gap-2">
          {valid && (
            <div className="panel-2 px-2 py-1 mono text-[10px] uppercase tracking-widest">
              <span className="muted">R </span>
              <span className={r >= 1 ? "up" : "warn"}>{r.toFixed(2)}</span>
            </div>
          )}
          <Button type="submit" disabled={busy}>
            <Plus weight="bold" className="inline mr-1" size={11} />
            {busy ? "Saving" : "Plan"}
          </Button>
        </div>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="thesis tag" />
        </Field>
        {valid && (
          <div className="md:col-span-8 panel-2 p-2">
            <RuleVisual kind="bracket" side={side} entry={e_} stop={s_} target={t_} width={520} height={36} />
          </div>
        )}
        {err && <div className="md:col-span-8 text-[11px] down mono">{err}</div>}
      </form>
    </Card>
  );
}
