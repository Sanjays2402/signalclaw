"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import {
  ClockCounterClockwise,
  Share,
  Trash,
  PencilSimple,
  Check,
  X,
  ArrowsClockwise,
  Copy,
} from "@phosphor-icons/react/dist/ssr";

type RunListItem = {
  id: string;
  label: string;
  ticker: string;
  lookback_days: number;
  created_at: string;
  bars: number;
  regime: string | null;
};

const fetcher = async (url: string) => {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

function tone(label: string | null): "up" | "down" | "warn" | "info" {
  if (label === "bull") return "up";
  if (label === "chop") return "warn";
  if (label === "bear" || label === "crash") return "down";
  return "info";
}

export default function HistoryPage() {
  const { data, error, isLoading, mutate } = useSWR<{ runs: RunListItem[] }>(
    "/api/runs",
    fetcher,
    { refreshInterval: 0 },
  );

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <section className="panel p-5">
        <div className="flex items-center gap-3">
          <ClockCounterClockwise size={22} weight="duotone" style={{ color: "var(--amber)" }} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Run history</h1>
            <p className="muted text-[12px] mt-0.5">
              Every regime classification you save shows up here. Re-run, rename, share, or delete.
            </p>
          </div>
        </div>
      </section>

      <Card
        title={`Saved runs${data?.runs ? ` · ${data.runs.length}` : ""}`}
        right={
          <button
            onClick={() => mutate()}
            className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] muted hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
          >
            <ArrowsClockwise size={11} weight="bold" /> Refresh
          </button>
        }
      >
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <Loading />
          </div>
        ) : error ? (
          <ErrorBox err={String(error)} />
        ) : !data || data.runs.length === 0 ? (
          <div className="py-8 flex flex-col items-center gap-3">
            <Empty title="No saved runs yet" hint="Run the demo and hit Save to capture a result." />
            <Link
              href="/demo"
              className="text-[11px] px-3 py-2 rounded-sm border border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)] uppercase tracking-widest font-semibold mono"
            >
              Run the demo
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {data.runs.map((r) => (
              <Row key={r.id} run={r} onChange={() => mutate()} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ run, onChange }: { run: RunListItem; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(run.label);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setEditing(false);
      onChange();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${run.label}"? This cannot be undone.`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${run.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`${r.status}`);
      onChange();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    const url = `${window.location.origin}/r/${run.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard might be unavailable in non-secure contexts. Fallback: select.
      window.prompt("Copy this link:", url);
    }
  }

  const when = new Date(run.created_at).toLocaleString();

  return (
    <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
              className="flex-1 bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm px-2 py-1 text-[13px] mono"
              autoFocus
            />
            <button
              onClick={save}
              disabled={busy || !label.trim()}
              className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-40"
              title="Save"
            >
              <Check size={14} weight="bold" />
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setLabel(run.label);
              }}
              className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5"
              title="Cancel"
            >
              <X size={14} weight="bold" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/r/${run.id}`}
              className="text-[13px] font-semibold hover:underline mono truncate"
            >
              {run.label}
            </Link>
            {run.regime && <Badge tone={tone(run.regime)}>{run.regime.toUpperCase()}</Badge>}
          </div>
        )}
        <div className="muted text-[10px] mono uppercase tracking-widest mt-1">
          {run.ticker} · {run.lookback_days}d · {run.bars} bars · {when}
        </div>
        {err && <div className="text-[11px] mt-1" style={{ color: "var(--red)" }}>{err}</div>}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Link
          href={`/demo?ticker=${encodeURIComponent(run.ticker)}&lookback=${run.lookback_days}`}
          className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono"
          title="Re-run with same parameters"
        >
          Re-run
        </Link>
        <button
          onClick={copyLink}
          className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1"
          title="Copy share link"
        >
          {copied ? <Check size={11} weight="bold" /> : <Copy size={11} weight="bold" />}
          {copied ? "Copied" : "Share"}
        </button>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5"
            title="Rename"
          >
            <PencilSimple size={12} weight="bold" />
          </button>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-40"
          title="Delete"
          style={{ color: "var(--red)" }}
        >
          <Trash size={12} weight="bold" />
        </button>
      </div>
    </div>
  );
}
