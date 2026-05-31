"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import {
  ClockCounterClockwise,
  Trash,
  PencilSimple,
  Check,
  X,
  ArrowsClockwise,
  Copy,
  MagnifyingGlass,
  DownloadSimple,
  CaretLeft,
  CaretRight,
  FileCsv,
  Code,
  Tag,
  Plus,
} from "@phosphor-icons/react/dist/ssr";

type TagCount = { tag: string; count: number };

type RunListItem = {
  id: string;
  label: string;
  ticker: string;
  lookback_days: number;
  created_at: string;
  bars: number;
  regime: string | null;
  confidence: number | null;
  tags: string[];
};

type ListResp = {
  runs: RunListItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

const PAGE_SIZE = 25;
const REGIMES = ["all", "bull", "chop", "bear", "crash"] as const;

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

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function HistoryPage() {
  const [q, setQ] = useState("");
  const [regime, setRegime] = useState<(typeof REGIMES)[number]>("all");
  const [tag, setTag] = useState<string>("");
  const [offset, setOffset] = useState(0);

  const dq = useDebounced(q, 200);

  const params = new URLSearchParams();
  if (dq) params.set("q", dq);
  if (regime !== "all") params.set("regime", regime);
  if (tag) params.set("tag", tag);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const key = `/api/runs?${params.toString()}`;
  const { data, error, isLoading, mutate } = useSWR<ListResp>(key, fetcher);
  const { data: tagsData, mutate: mutateTags } = useSWR<{ tags: TagCount[] }>(
    "/api/runs/tags",
    fetcher,
  );
  const allTags = tagsData?.tags ?? [];

  function refreshAll() {
    mutate();
    mutateTags();
  }

  const exportParams = new URLSearchParams();
  if (dq) exportParams.set("q", dq);
  if (regime !== "all") exportParams.set("regime", regime);
  if (tag) exportParams.set("tag", tag);

  function go(delta: number) {
    const next = Math.max(0, offset + delta * PAGE_SIZE);
    setOffset(next);
  }

  function resetFilters() {
    setQ("");
    setRegime("all");
    setTag("");
    setOffset(0);
  }

  const total = data?.total ?? 0;
  const page = data?.runs ?? [];
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + page.length, total);
  const hasFilters = dq.length > 0 || regime !== "all" || tag.length > 0;

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <section className="panel p-5">
        <div className="flex items-center gap-3">
          <ClockCounterClockwise size={22} weight="duotone" style={{ color: "var(--amber)" }} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Run history</h1>
            <p className="muted text-[12px] mt-0.5">
              Search, filter, page through saved runs. Export the current selection as CSV or JSON.
            </p>
          </div>
        </div>
      </section>

      <Card
        title={`Saved runs${data ? ` · ${total}` : ""}`}
        right={
          <div className="flex items-center gap-1.5">
            <a
              href={`/api/runs/export?${exportParams.toString()}&format=csv`}
              className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
              title="Download CSV of matching runs"
            >
              <FileCsv size={11} weight="bold" /> CSV
            </a>
            <a
              href={`/api/runs/export?${exportParams.toString()}&format=json`}
              className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
              title="Download JSON of matching runs"
            >
              <Code size={11} weight="bold" /> JSON
            </a>
            <button
              onClick={refreshAll}
              className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] muted hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
            >
              <ArrowsClockwise size={11} weight="bold" /> Refresh
            </button>
          </div>
        }
      >
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <label className="relative flex-1">
            <MagnifyingGlass
              size={13}
              weight="bold"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 muted pointer-events-none"
            />
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
              placeholder="Search label, ticker, or id"
              aria-label="Search runs"
              className="w-full bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm pl-8 pr-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]/60"
            />
          </label>
          <div className="flex items-center gap-1 flex-wrap">
            {REGIMES.map((r) => {
              const active = regime === r;
              return (
                <button
                  key={r}
                  onClick={() => {
                    setRegime(r);
                    setOffset(0);
                  }}
                  aria-pressed={active}
                  className={
                    "text-[10px] px-2 py-1.5 rounded-sm border uppercase tracking-widest font-semibold mono " +
                    (active
                      ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                      : "border-[var(--border-strong)] hover:bg-white/5 muted")
                  }
                >
                  {r}
                </button>
              );
            })}
            {hasFilters && (
              <button
                onClick={resetFilters}
                className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1"
                title="Clear filters"
              >
                <X size={11} weight="bold" /> Clear
              </button>
            )}
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap mb-4 pb-3 border-b border-[var(--border)]">
            <Tag size={12} weight="duotone" className="muted" />
            <span className="text-[10px] mono uppercase tracking-widest muted mr-1">Tags</span>
            <button
              onClick={() => {
                setTag("");
                setOffset(0);
              }}
              aria-pressed={tag === ""}
              className={
                "text-[10px] px-2 py-1 rounded-sm border uppercase tracking-widest font-semibold mono " +
                (tag === ""
                  ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                  : "border-[var(--border-strong)] hover:bg-white/5 muted")
              }
            >
              All
            </button>
            {allTags.map((t) => {
              const active = tag === t.tag;
              return (
                <button
                  key={t.tag}
                  onClick={() => {
                    setTag(active ? "" : t.tag);
                    setOffset(0);
                  }}
                  aria-pressed={active}
                  className={
                    "text-[10px] px-2 py-1 rounded-sm border lowercase font-medium mono flex items-center gap-1 " +
                    (active
                      ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                      : "border-[var(--border-strong)] hover:bg-white/5")
                  }
                  title={`Filter by tag ${t.tag} (${t.count})`}
                >
                  #{t.tag}
                  <span className="muted text-[9px]">{t.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {isLoading && !data ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-12 rounded-sm border border-[var(--border)] animate-pulse bg-white/[0.02]"
              />
            ))}
          </div>
        ) : error ? (
          <ErrorBox err={String(error)} />
        ) : page.length === 0 ? (
          hasFilters ? (
            <Empty
              title="No runs match these filters"
              hint="Try clearing the search or switching regime."
            />
          ) : (
            <div className="py-8 flex flex-col items-center gap-3">
              <Empty
                title="No saved runs yet"
                hint="Run the demo and hit Save to capture a result."
              />
              <Link
                href="/demo"
                className="text-[11px] px-3 py-2 rounded-sm border border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)] uppercase tracking-widest font-semibold mono"
              >
                Run the demo
              </Link>
            </div>
          )
        ) : (
          <>
            <div className="divide-y divide-[var(--border)]">
              {page.map((r) => (
                <Row key={r.id} run={r} onChange={refreshAll} />
              ))}
            </div>
            <div className="flex items-center justify-between mt-4 text-[10px] mono uppercase tracking-widest muted">
              <div>
                {showingFrom} to {showingTo} of {total}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => go(-1)}
                  disabled={offset === 0}
                  className="px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-30 flex items-center gap-1"
                  aria-label="Previous page"
                >
                  <CaretLeft size={11} weight="bold" /> Prev
                </button>
                <button
                  onClick={() => go(1)}
                  disabled={!data?.has_more}
                  className="px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-30 flex items-center gap-1"
                  aria-label="Next page"
                >
                  Next <CaretRight size={11} weight="bold" />
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Row({ run, onChange }: { run: RunListItem; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(run.label);
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState((run.tags ?? []).join(", "));
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

  async function saveTags() {
    const tags = tagDraft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setEditingTags(false);
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
              aria-label="Save label"
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
              aria-label="Cancel rename"
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
            {run.confidence !== null && (
              <span className="text-[10px] mono uppercase tracking-widest muted">
                {Math.round(run.confidence * 100)}% conf
              </span>
            )}
          </div>
        )}
        <div className="muted text-[10px] mono uppercase tracking-widest mt-1">
          {run.ticker} · {run.lookback_days}d · {run.bars} bars · {when}
        </div>
        <div className="mt-1.5">
          {editingTags ? (
            <div className="flex items-center gap-2">
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="comma-separated, e.g. swing, watch, q2"
                aria-label="Edit tags"
                maxLength={200}
                className="flex-1 bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm px-2 py-1 text-[11px] mono"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveTags();
                  if (e.key === "Escape") {
                    setEditingTags(false);
                    setTagDraft((run.tags ?? []).join(", "));
                  }
                }}
              />
              <button
                onClick={saveTags}
                disabled={busy}
                className="p-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-40"
                title="Save tags"
                aria-label="Save tags"
              >
                <Check size={12} weight="bold" />
              </button>
              <button
                onClick={() => {
                  setEditingTags(false);
                  setTagDraft((run.tags ?? []).join(", "));
                }}
                className="p-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5"
                title="Cancel"
                aria-label="Cancel tag edit"
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ) : (run.tags ?? []).length > 0 ? (
            <div className="flex items-center gap-1 flex-wrap">
              {run.tags.map((t) => (
                <span
                  key={t}
                  className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-[var(--border)] muted lowercase"
                >
                  #{t}
                </span>
              ))}
              <button
                onClick={() => setEditingTags(true)}
                className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-dashed border-[var(--border-strong)] hover:bg-white/5 muted flex items-center gap-0.5"
                title="Edit tags"
                aria-label="Edit tags"
              >
                <PencilSimple size={9} weight="bold" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditingTags(true)}
              className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-dashed border-[var(--border-strong)] hover:bg-white/5 muted flex items-center gap-1"
              title="Add tags"
              aria-label="Add tags"
            >
              <Plus size={9} weight="bold" /> add tag
            </button>
          )}
        </div>
        {err && (
          <div className="text-[11px] mt-1" style={{ color: "var(--red)" }}>
            {err}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
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
        <a
          href={`/api/runs/${run.id}/export?format=csv`}
          className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1"
          title="Download CSV"
        >
          <DownloadSimple size={11} weight="bold" /> CSV
        </a>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5"
            title="Rename"
            aria-label="Rename run"
          >
            <PencilSimple size={12} weight="bold" />
          </button>
        )}
        <button
          onClick={remove}
          disabled={busy}
          className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-40"
          title="Delete"
          aria-label="Delete run"
          style={{ color: "var(--red)" }}
        >
          <Trash size={12} weight="bold" />
        </button>
      </div>
    </div>
  );
}
