"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Card, Loading, ErrorBox, Empty, Badge } from "@/components/ui";
import PinnedRail from "@/components/PinnedRail";
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
  NotePencil,
  PushPin,
  PushPinSlash,
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
  notes: string;
  pinned: boolean;
  pinned_at: string | null;
  owner?: { key_id: string; key_label: string | null } | null;
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
const SORTS = [
  { value: "recent", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "ticker", label: "Ticker A-Z" },
  { value: "confidence", label: "Confidence" },
  { value: "bars", label: "Bars" },
] as const;
type SortValue = (typeof SORTS)[number]["value"];

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
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [sort, setSort] = useState<SortValue>("recent");
  const [offset, setOffset] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate filters from URL query once on mount so links like
  // /history?tag=earnings or /history?regime=bull&pinned=1 work as deep links.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const urlQ = sp.get("q");
    if (urlQ) setQ(urlQ);
    const urlRegime = sp.get("regime");
    if (urlRegime && (REGIMES as readonly string[]).includes(urlRegime)) {
      setRegime(urlRegime as (typeof REGIMES)[number]);
    }
    const urlTag = sp.get("tag");
    if (urlTag) setTag(urlTag);
    if (sp.get("pinned") === "1") setPinnedOnly(true);
    const urlSort = sp.get("sort");
    if (urlSort && SORTS.some((s) => s.value === urlSort)) {
      setSort(urlSort as SortValue);
    }
    setHydrated(true);
  }, []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErr, setBulkErr] = useState<string | null>(null);
  const [bulkTagDraft, setBulkTagDraft] = useState("");
  const [bulkTagMode, setBulkTagMode] = useState<null | "add" | "remove">(null);

  const dq = useDebounced(q, 200);

  const params = new URLSearchParams();
  if (dq) params.set("q", dq);
  if (regime !== "all") params.set("regime", regime);
  if (tag) params.set("tag", tag);
  if (pinnedOnly) params.set("pinned", "1");
  if (sort !== "recent") params.set("sort", sort);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));

  const key = `/api/runs?${params.toString()}`;
  // Wait for URL filter hydration so deep-links like /history?tag=foo don't
  // briefly request the unfiltered list before the URL filters apply.
  const { data, error, isLoading, mutate } = useSWR<ListResp>(
    hydrated ? key : null,
    fetcher,
  );
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
  if (pinnedOnly) exportParams.set("pinned", "1");
  if (sort !== "recent") exportParams.set("sort", sort);

  function go(delta: number) {
    const next = Math.max(0, offset + delta * PAGE_SIZE);
    setOffset(next);
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function clearSelection() {
    setSelected(new Set());
    setBulkTagMode(null);
    setBulkTagDraft("");
    setBulkErr(null);
  }

  async function runBulk(
    action: "delete" | "pin" | "unpin" | "add_tags" | "remove_tags",
    tags?: string[],
  ) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (action === "delete" && !confirm(`Delete ${ids.length} run(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const body: Record<string, unknown> = { ids, action };
      if (tags) body.tags = tags;
      const r = await fetch(`/api/runs/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error?.message ?? `${r.status}`);
      }
      clearSelection();
      refreshAll();
    } catch (e: any) {
      setBulkErr(String(e?.message || e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkExport(format: "csv" | "json") {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkErr(null);
    try {
      const r = await fetch(`/api/runs/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, action: "export", format }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error?.message ?? `${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      a.download = `signalclaw-runs-selected-${stamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setBulkErr(String(e?.message || e));
    } finally {
      setBulkBusy(false);
    }
  }

  function submitBulkTags() {
    const tags = bulkTagDraft
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tags.length === 0 || !bulkTagMode) return;
    runBulk(bulkTagMode === "add" ? "add_tags" : "remove_tags", tags);
  }

  function resetFilters() {
    setQ("");
    setRegime("all");
    setTag("");
    setPinnedOnly(false);
    setSort("recent");
    setOffset(0);
  }

  const total = data?.total ?? 0;
  const page = data?.runs ?? [];
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + page.length, total);
  const hasFilters = dq.length > 0 || regime !== "all" || tag.length > 0 || pinnedOnly || sort !== "recent";

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

      <PinnedRail />

      <Card
        title={`Saved runs${data ? ` · ${total}` : ""}`}
        right={
          <div className="flex items-center gap-1.5">
            <a
              href={`/api/runs/export?${exportParams.toString()}&format=csv`}
              className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
              title={total > 200 ? `Download CSV (first 200 of ${total} matching runs)` : "Download CSV of matching runs"}
            >
              <FileCsv size={11} weight="bold" /> CSV
            </a>
            <a
              href={`/api/runs/export?${exportParams.toString()}&format=json`}
              className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1.5"
              title={total > 200 ? `Download JSON (first 200 of ${total} matching runs)` : "Download JSON of matching runs"}
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
              placeholder="Search label, ticker, id, tag, or notes"
              aria-label="Search runs"
              className="w-full bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm pl-8 pr-2 py-1.5 text-[12px] mono focus:outline-none focus:border-[var(--amber)]/60"
            />
          </label>
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => {
                setPinnedOnly((v) => !v);
                setOffset(0);
              }}
              aria-pressed={pinnedOnly}
              title={pinnedOnly ? "Showing pinned only" : "Show pinned only"}
              className={
                "text-[10px] px-2 py-1.5 rounded-sm border uppercase tracking-widest font-semibold mono flex items-center gap-1 " +
                (pinnedOnly
                  ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                  : "border-[var(--border-strong)] hover:bg-white/5 muted")
              }
            >
              <PushPin size={11} weight={pinnedOnly ? "fill" : "bold"} /> Pinned
            </button>
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
            <label
              className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] uppercase tracking-widest font-semibold mono flex items-center gap-1 muted hover:bg-white/5"
              title="Sort the run list"
            >
              Sort
              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as SortValue);
                  setOffset(0);
                }}
                aria-label="Sort runs"
                className="bg-transparent text-[10px] mono uppercase tracking-widest focus:outline-none cursor-pointer"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value} className="bg-[var(--bg)] text-white">
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
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
            {(() => {
              const pageIds = page.map((r) => r.id);
              const selectedOnPage = pageIds.filter((id) => selected.has(id)).length;
              const allOnPage = pageIds.length > 0 && selectedOnPage === pageIds.length;
              const someOnPage = selectedOnPage > 0 && !allOnPage;
              function toggleAllOnPage() {
                setSelected((prev) => {
                  const n = new Set(prev);
                  if (allOnPage) for (const id of pageIds) n.delete(id);
                  else for (const id of pageIds) n.add(id);
                  return n;
                });
              }
              return (
                <div className="flex items-center justify-between gap-2 mb-2 px-1">
                  <label className="flex items-center gap-2 text-[11px] mono uppercase tracking-widest muted cursor-pointer select-none">
                    <input
                      type="checkbox"
                      aria-label="Select all runs on this page"
                      checked={allOnPage}
                      ref={(el) => {
                        if (el) el.indeterminate = someOnPage;
                      }}
                      onChange={toggleAllOnPage}
                      className="accent-[var(--amber)]"
                    />
                    {selected.size > 0 ? `${selected.size} selected` : "Select all"}
                  </label>
                  {selected.size > 0 && (
                    <button
                      onClick={clearSelection}
                      className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono"
                    >
                      Clear
                    </button>
                  )}
                </div>
              );
            })()}
            {selected.size > 0 && (
              <div className="sticky top-0 z-10 mb-3 panel border border-[var(--amber)]/30 bg-[var(--bg-elev)] p-2 rounded-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] mono uppercase tracking-widest text-[var(--amber)] mr-2">
                    {selected.size} run{selected.size === 1 ? "" : "s"}
                  </span>
                  <button
                    disabled={bulkBusy}
                    onClick={() => runBulk("pin")}
                    className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50"
                  >
                    <PushPin size={11} weight="bold" /> Pin
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => runBulk("unpin")}
                    className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50"
                  >
                    <PushPinSlash size={11} weight="bold" /> Unpin
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => {
                      setBulkTagMode((m) => (m === "add" ? null : "add"));
                    }}
                    aria-pressed={bulkTagMode === "add"}
                    className={
                      "text-[10px] px-2 py-1 rounded-sm border uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50 " +
                      (bulkTagMode === "add"
                        ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                        : "border-[var(--border-strong)] hover:bg-white/5")
                    }
                  >
                    <Plus size={11} weight="bold" /> Add tag
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => {
                      setBulkTagMode((m) => (m === "remove" ? null : "remove"));
                    }}
                    aria-pressed={bulkTagMode === "remove"}
                    className={
                      "text-[10px] px-2 py-1 rounded-sm border uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50 " +
                      (bulkTagMode === "remove"
                        ? "border-[var(--amber)]/60 bg-[var(--amber)]/10 text-[var(--amber)]"
                        : "border-[var(--border-strong)] hover:bg-white/5")
                    }
                  >
                    <X size={11} weight="bold" /> Remove tag
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => bulkExport("csv")}
                    className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50"
                  >
                    <FileCsv size={11} weight="bold" /> CSV
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => bulkExport("json")}
                    className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50"
                  >
                    <Code size={11} weight="bold" /> JSON
                  </button>
                  <button
                    disabled={bulkBusy}
                    onClick={() => runBulk("delete")}
                    className="text-[10px] px-2 py-1 rounded-sm border border-red-500/40 text-red-400 hover:bg-red-500/10 uppercase tracking-widest font-semibold mono flex items-center gap-1 disabled:opacity-50"
                  >
                    <Trash size={11} weight="bold" /> Delete
                  </button>
                </div>
                {bulkTagMode && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={bulkTagDraft}
                      onChange={(e) => setBulkTagDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitBulkTags();
                        if (e.key === "Escape") {
                          setBulkTagMode(null);
                          setBulkTagDraft("");
                        }
                      }}
                      placeholder="tag1, tag2"
                      aria-label="Tags to apply"
                      className="flex-1 bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm px-2 py-1 text-[11px] mono focus:outline-none focus:border-[var(--amber)]/60"
                    />
                    <button
                      disabled={bulkBusy || !bulkTagDraft.trim()}
                      onClick={submitBulkTags}
                      className="text-[10px] px-2 py-1 rounded-sm border border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)] uppercase tracking-widest font-semibold mono disabled:opacity-50"
                    >
                      <Check size={11} weight="bold" />
                    </button>
                  </div>
                )}
                {bulkErr && (
                  <div className="mt-2 text-[11px] mono text-red-400">{bulkErr}</div>
                )}
              </div>
            )}
            <div className="divide-y divide-[var(--border)]">
              {page.map((r) => (
                <Row
                  key={r.id}
                  run={r}
                  onChange={refreshAll}
                  selected={selected.has(r.id)}
                  onToggleSelect={() => toggleSelect(r.id)}
                />
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

function Row({
  run,
  onChange,
  selected,
  onToggleSelect,
}: {
  run: RunListItem;
  onChange: () => void;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(run.label);
  const [editingTags, setEditingTags] = useState(false);
  const [tagDraft, setTagDraft] = useState((run.tags ?? []).join(", "));
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState(run.notes ?? "");
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

  async function saveNotes() {
    const notes = notesDraft.slice(0, 2000);
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setEditingNotes(false);
      onChange();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function togglePin() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/runs/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: !run.pinned }),
      });
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
      window.prompt("Copy this link:", url);
    }
  }

  const when = new Date(run.created_at).toLocaleString();

  return (
    <div
      className={
        "py-3 flex flex-col sm:flex-row sm:items-center gap-3 " +
        (selected ? "bg-[var(--amber)]/5" : "")
      }
    >
      {onToggleSelect && (
        <label className="flex items-center self-start sm:self-center pt-1 sm:pt-0 cursor-pointer">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={onToggleSelect}
            aria-label={`Select run ${run.label}`}
            className="accent-[var(--amber)]"
          />
        </label>
      )}
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
            {run.pinned && (
              <PushPin
                size={11}
                weight="fill"
                style={{ color: "var(--amber)" }}
                aria-label="Pinned"
              />
            )}
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
          {run.owner && (
            <span
              className="ml-2 normal-case tracking-normal"
              title={`Owned by API key ${run.owner.key_label ?? run.owner.key_id}. Only that key or an admin key can delete or rename this run via /v1.`}
            >
              · api: {(run.owner.key_label ?? run.owner.key_id).slice(0, 18)}
            </span>
          )}
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
        <div className="mt-1.5">
          {editingNotes ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value.slice(0, 2000))}
                placeholder="Why this run matters. Setup, catalyst, what to watch."
                aria-label="Edit notes"
                maxLength={2000}
                rows={3}
                className="w-full bg-[var(--bg)] border border-[var(--border-strong)] rounded-sm px-2 py-1.5 text-[12px] leading-relaxed resize-y"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNotes();
                  if (e.key === "Escape") {
                    setEditingNotes(false);
                    setNotesDraft(run.notes ?? "");
                  }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="muted text-[10px] mono">
                  {notesDraft.length}/2000 · cmd+enter to save
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={saveNotes}
                    disabled={busy}
                    className="text-[10px] px-2 py-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono disabled:opacity-40 flex items-center gap-1"
                    title="Save notes"
                    aria-label="Save notes"
                  >
                    <Check size={11} weight="bold" /> Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingNotes(false);
                      setNotesDraft(run.notes ?? "");
                    }}
                    className="p-1 rounded-sm border border-[var(--border-strong)] hover:bg-white/5"
                    title="Cancel"
                    aria-label="Cancel notes edit"
                  >
                    <X size={11} weight="bold" />
                  </button>
                </div>
              </div>
            </div>
          ) : (run.notes ?? "").trim().length > 0 ? (
            <button
              onClick={() => {
                setNotesDraft(run.notes ?? "");
                setEditingNotes(true);
              }}
              className="w-full text-left flex items-start gap-1.5 group"
              title="Edit notes"
              aria-label="Edit notes"
            >
              <NotePencil
                size={11}
                weight="duotone"
                className="shrink-0 mt-0.5 muted group-hover:opacity-100"
                style={{ color: "var(--accent)" }}
              />
              <span className="text-[11px] muted line-clamp-2 group-hover:text-white whitespace-pre-wrap break-words">
                {run.notes}
              </span>
            </button>
          ) : (
            <button
              onClick={() => {
                setNotesDraft("");
                setEditingNotes(true);
              }}
              className="text-[10px] mono px-1.5 py-0.5 rounded-sm border border-dashed border-[var(--border-strong)] hover:bg-white/5 muted flex items-center gap-1"
              title="Add notes"
              aria-label="Add notes"
            >
              <NotePencil size={9} weight="bold" /> add notes
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
        <button
          onClick={togglePin}
          disabled={busy}
          className="p-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 disabled:opacity-40"
          title={run.pinned ? "Unpin run" : "Pin run"}
          aria-label={run.pinned ? "Unpin run" : "Pin run"}
          aria-pressed={run.pinned}
          style={run.pinned ? { color: "var(--amber)" } : undefined}
        >
          {run.pinned ? (
            <PushPinSlash size={12} weight="bold" />
          ) : (
            <PushPin size={12} weight="bold" />
          )}
        </button>
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
        <a
          href={`/api/runs/${run.id}/pdf`}
          className="text-[10px] px-2 py-1.5 rounded-sm border border-[var(--border-strong)] hover:bg-white/5 uppercase tracking-widest font-semibold mono flex items-center gap-1"
          title="Download PDF report"
        >
          <DownloadSimple size={11} weight="bold" /> PDF
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
