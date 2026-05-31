"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api";
import { Card, Button, Input, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import {
  ArrowRight,
  Trash,
  Star,
  DownloadSimple,
  PencilSimple,
  Check,
  X,
  Target,
  ArrowsClockwise,
  TrendUp,
  TrendDown,
} from "@phosphor-icons/react/dist/ssr";

type Entry = {
  ticker: string;
  added_at: string;
  note: string | null;
  target_high: number | null;
  target_low: number | null;
  last_cross: { side: "above_high" | "below_low"; price: number; at: string } | null;
};
type ListResp = { tickers: string[]; entries: Entry[]; total: number; limit: number };

type CheckRow = {
  ticker: string;
  target_high: number | null;
  target_low: number | null;
  last_close: number | null;
  last_close_at: string | null;
  source_run_id: string | null;
  status: "no_targets" | "no_data" | "inside" | "above_high" | "below_low";
  crossed_now: boolean;
};
type CheckResp = {
  checked_at: string;
  count: number;
  fired_now: number;
  rows: CheckRow[];
};

export default function Page() {
  return (
    <AuthGate>
      <WL />
    </AuthGate>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function fmtPrice(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function WL() {
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editTargets, setEditTargets] = useState<string | null>(null);
  const [targetHigh, setTargetHigh] = useState("");
  const [targetLow, setTargetLow] = useState("");
  const [checks, setChecks] = useState<Record<string, CheckRow>>({});
  const [checkResp, setCheckResp] = useState<CheckResp | null>(null);
  const [checking, setChecking] = useState(false);

  const load = async () => {
    setErr(null);
    try {
      const d = await api<ListResp>("/watchlist");
      setData(d);
    } catch (e) {
      setErr(e);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api("/watchlist", {
        method: "POST",
        body: JSON.stringify({
          ticker: ticker.trim().toUpperCase(),
          note: note.trim() || null,
        }),
      });
      setTicker("");
      setNote("");
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: string) => {
    try {
      await api(`/watchlist/${encodeURIComponent(t)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const saveNote = async (t: string) => {
    try {
      await api(`/watchlist/${encodeURIComponent(t)}`, {
        method: "PATCH",
        body: JSON.stringify({ note: editNote.trim() || null }),
      });
      setEditing(null);
      setEditNote("");
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const saveTargets = async (t: string) => {
    setErr(null);
    try {
      const hi = targetHigh.trim() === "" ? null : Number.parseFloat(targetHigh);
      const lo = targetLow.trim() === "" ? null : Number.parseFloat(targetLow);
      if (hi !== null && !Number.isFinite(hi)) {
        setErr(new Error("Target high must be a number"));
        return;
      }
      if (lo !== null && !Number.isFinite(lo)) {
        setErr(new Error("Target low must be a number"));
        return;
      }
      await api(`/watchlist/${encodeURIComponent(t)}`, {
        method: "PATCH",
        body: JSON.stringify({ target_high: hi, target_low: lo }),
      });
      setEditTargets(null);
      setTargetHigh("");
      setTargetLow("");
      await load();
    } catch (e) {
      setErr(e);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    setErr(null);
    try {
      const resp = await api<CheckResp>("/watchlist/check");
      setCheckResp(resp);
      const map: Record<string, CheckRow> = {};
      for (const row of resp.rows) map[row.ticker] = row;
      setChecks(map);
      // refresh entries so last_cross updates
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setChecking(false);
    }
  };

  const entries = data?.entries ?? null;
  const anyTargets = (entries ?? []).some((e) => e.target_high !== null || e.target_low !== null);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Star weight="duotone" size={22} className="text-[var(--accent)]" />
            Watchlist
          </h1>
          <p className="muted text-xs">
            Tickers tracked by the daily pipeline. Set price targets and check for crosses.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={checkNow}
            disabled={checking || !anyTargets}
            title={anyTargets ? "Compare last close against your targets" : "Set a target first"}
          >
            <ArrowsClockwise weight="duotone" size={14} className={checking ? "animate-spin" : ""} />
            <span className="ml-1">{checking ? "Checking" : "Check now"}</span>
          </Button>
          <a
            href="/api/watchlist?format=csv"
            className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
          >
            <DownloadSimple weight="duotone" size={14} /> Export CSV
          </a>
        </div>
      </header>

      <Card title="Add ticker">
        <form onSubmit={add} className="flex gap-2 flex-wrap sm:flex-nowrap">
          <Input
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="AAPL"
            className="mono w-full sm:w-32"
            maxLength={16}
          />
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. earnings 2/1)"
            className="flex-1"
            maxLength={200}
          />
          <Button type="submit" disabled={busy || !ticker.trim()}>
            {busy ? "Adding" : "Add"}
          </Button>
        </form>
        {data && (
          <div className="muted text-[10px] mt-2 uppercase tracking-widest">
            {data.total} / {data.limit} tracked
          </div>
        )}
      </Card>

      {checkResp && (
        <div className="panel p-3 text-[11px] flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Target weight="duotone" size={14} className="text-[var(--accent)]" />
            <span className="mono">checked {new Date(checkResp.checked_at).toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-3 muted">
            <span>{checkResp.count} target row(s)</span>
            {checkResp.fired_now > 0 && (
              <Badge tone="warn">{checkResp.fired_now} new cross</Badge>
            )}
          </div>
        </div>
      )}

      {err ? (
        <ErrorBox err={err} />
      ) : entries == null ? (
        <Loading label="Loading watchlist" />
      ) : entries.length === 0 ? (
        <Empty
          title="No tickers yet"
          hint="Add a symbol above to seed the daily pipeline."
        />
      ) : (
        <ul className="panel divide-y divide-[var(--border)]">
          {entries.map((e) => {
            const check = checks[e.ticker];
            const isCrossed = check && (check.status === "above_high" || check.status === "below_low");
            return (
              <li
                key={e.ticker}
                className="px-4 py-3 hover:bg-white/[0.02] flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/ticker/${e.ticker}`}
                        className="mono inline-flex items-center gap-1 hover:text-[var(--accent)] font-semibold"
                      >
                        {e.ticker}
                        <ArrowRight weight="duotone" size={12} className="opacity-60" />
                      </Link>
                      <span className="muted text-[10px] uppercase tracking-widest">
                        added {fmtDate(e.added_at)}
                      </span>
                      {isCrossed && check && (
                        <Badge tone={check.status === "above_high" ? "up" : "down"}>
                          {check.status === "above_high" ? (
                            <TrendUp weight="duotone" size={10} />
                          ) : (
                            <TrendDown weight="duotone" size={10} />
                          )}
                          <span className="ml-1">
                            {check.status === "above_high" ? "above high" : "below low"}
                          </span>
                        </Badge>
                      )}
                    </div>
                    {editing === e.ticker ? (
                      <div className="flex gap-1 mt-1.5">
                        <Input
                          value={editNote}
                          onChange={(ev) => setEditNote(ev.target.value)}
                          placeholder="Note"
                          className="flex-1 text-xs"
                          maxLength={200}
                          autoFocus
                        />
                        <button
                          onClick={() => saveNote(e.ticker)}
                          className="px-2 hover:text-[var(--accent)]"
                          aria-label="Save note"
                        >
                          <Check weight="duotone" size={14} />
                        </button>
                        <button
                          onClick={() => {
                            setEditing(null);
                            setEditNote("");
                          }}
                          className="px-2 muted hover:text-[var(--red)]"
                          aria-label="Cancel"
                        >
                          <X weight="duotone" size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="text-xs muted mt-0.5 flex items-center gap-2">
                        {e.note ? (
                          <span className="truncate">{e.note}</span>
                        ) : (
                          <span className="opacity-60">no note</span>
                        )}
                        <button
                          onClick={() => {
                            setEditing(e.ticker);
                            setEditNote(e.note ?? "");
                          }}
                          className="hover:text-[var(--accent)]"
                          aria-label="Edit note"
                        >
                          <PencilSimple weight="duotone" size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => remove(e.ticker)}
                    className="text-xs muted hover:text-[var(--red)] inline-flex items-center gap-1"
                    aria-label={`Remove ${e.ticker}`}
                  >
                    <Trash weight="duotone" size={12} /> remove
                  </button>
                </div>

                {/* Target row */}
                {editTargets === e.ticker ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs border-t border-[var(--border)] pt-2">
                    <span className="muted mono text-[10px] uppercase tracking-widest">low</span>
                    <Input
                      value={targetLow}
                      onChange={(ev) => setTargetLow(ev.target.value)}
                      placeholder="e.g. 150"
                      className="w-24 mono"
                      inputMode="decimal"
                    />
                    <span className="muted mono text-[10px] uppercase tracking-widest">high</span>
                    <Input
                      value={targetHigh}
                      onChange={(ev) => setTargetHigh(ev.target.value)}
                      placeholder="e.g. 200"
                      className="w-24 mono"
                      inputMode="decimal"
                    />
                    <button
                      onClick={() => saveTargets(e.ticker)}
                      className="px-2 hover:text-[var(--accent)]"
                      aria-label="Save targets"
                    >
                      <Check weight="duotone" size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setEditTargets(null);
                        setTargetHigh("");
                        setTargetLow("");
                      }}
                      className="px-2 muted hover:text-[var(--red)]"
                      aria-label="Cancel"
                    >
                      <X weight="duotone" size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 text-[11px] border-t border-[var(--border)] pt-2">
                    <div className="flex items-center gap-1.5">
                      <Target weight="duotone" size={12} className="text-[var(--accent)]" />
                      <span className="mono muted">low</span>
                      <span className="mono">{fmtPrice(e.target_low)}</span>
                      <span className="mono muted">/ high</span>
                      <span className="mono">{fmtPrice(e.target_high)}</span>
                    </div>
                    {check && check.last_close !== null && (
                      <div className="mono muted">
                        last close <span className="text-[var(--fg)]">{fmtPrice(check.last_close)}</span>
                        {check.last_close_at && (
                          <span className="opacity-60"> · {check.last_close_at}</span>
                        )}
                      </div>
                    )}
                    {check && check.status === "no_data" && (
                      <span className="muted">no run data yet</span>
                    )}
                    <button
                      onClick={() => {
                        setEditTargets(e.ticker);
                        setTargetLow(e.target_low === null ? "" : String(e.target_low));
                        setTargetHigh(e.target_high === null ? "" : String(e.target_high));
                      }}
                      className="ml-auto hover:text-[var(--accent)] inline-flex items-center gap-1"
                      aria-label="Edit targets"
                    >
                      <PencilSimple weight="duotone" size={12} /> targets
                    </button>
                  </div>
                )}

                {e.last_cross && (
                  <div className="text-[10px] muted mono">
                    last cross: {e.last_cross.side === "above_high" ? "above high" : "below low"} at {fmtPrice(e.last_cross.price)} on {fmtDate(e.last_cross.at)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
