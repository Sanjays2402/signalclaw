"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api";
import { Card, Button, Input, Loading, ErrorBox, Empty } from "@/components/ui";
import {
  ArrowRight,
  Trash,
  Star,
  DownloadSimple,
  PencilSimple,
  Check,
  X,
} from "@phosphor-icons/react/dist/ssr";

type Entry = { ticker: string; added_at: string; note: string | null };
type ListResp = { tickers: string[]; entries: Entry[]; total: number; limit: number };

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

function WL() {
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [ticker, setTicker] = useState("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");

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

  const entries = data?.entries ?? null;

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Star weight="duotone" size={22} className="text-[var(--accent)]" />
            Watchlist
          </h1>
          <p className="muted text-xs">
            Tickers tracked by the daily pipeline. Click any symbol for detail.
          </p>
        </div>
        <a
          href="/api/watchlist?format=csv"
          className="text-xs inline-flex items-center gap-1 px-2.5 py-1.5 border border-[var(--border)] hover:border-[var(--accent)] rounded"
        >
          <DownloadSimple weight="duotone" size={14} /> Export CSV
        </a>
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
          {entries.map((e) => (
            <li
              key={e.ticker}
              className="px-4 py-3 hover:bg-white/[0.02] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
            >
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
                className="text-xs muted hover:text-[var(--red)] inline-flex items-center gap-1 self-end sm:self-auto"
                aria-label={`Remove ${e.ticker}`}
              >
                <Trash weight="duotone" size={12} /> remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
