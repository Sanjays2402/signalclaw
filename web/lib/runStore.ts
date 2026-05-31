// File-backed JSON store for saved demo runs.
// Persisted at web/.data/runs.json so saves survive process restarts.
// Not a real DB, but real persistence with atomic writes.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maybeAutoSweep } from "./retentionStore.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "runs.json");
const MAX_RUNS = 500;

export const MAX_NOTES_LEN = 2000;

export function normalizeNotes(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string") return "";
  // Strip control chars except tab/newline, trim, cap length.
  const cleaned = input.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  return cleaned.slice(0, MAX_NOTES_LEN);
}

export type SavedRun = {
  id: string;
  label: string;
  ticker: string;
  lookback_days: number;
  created_at: string;
  tags: string[];
  notes?: string;
  pinned?: boolean;
  pinned_at?: string | null;
  // RBAC ownership: the API key id (and its label snapshot) that created this run
  // through /api/v1/runs. Older rows (pre-RBAC) and runs created via the local
  // dashboard leave this undefined; those are treated as unowned and remain
  // mutable by any trade-scoped caller for back-compat.
  created_by_key_id?: string | null;
  created_by_key_label?: string | null;
  payload: {
    ticker: string;
    dates: string[];
    close: number[];
    regime: (string | null)[];
    counts: Record<string, number>;
    snapshot: {
      label: string;
      realized_vol: number;
      trend_slope: number;
      drawdown: number;
      confidence: number;
      risk_scale: number;
      as_of: string;
    } | null;
    disclaimer: string;
  };
};

type Store = { runs: SavedRun[] };

// Tag rules: lowercase, [a-z0-9-], 1..24 chars, dedup, cap 8 per run.
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const MAX_TAGS_PER_RUN = 8;

export function normalizeTags(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  const arr = Array.isArray(input) ? input : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!t || !TAG_RE.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS_PER_RUN) break;
  }
  return out;
}

function ensureTags(r: SavedRun): SavedRun {
  if (!Array.isArray((r as any).tags)) (r as any).tags = [];
  if (typeof (r as any).notes !== "string") (r as any).notes = "";
  if (typeof (r as any).pinned !== "boolean") (r as any).pinned = false;
  if ((r as any).pinned_at === undefined) (r as any).pinned_at = null;
  return r;
}

export async function setRunPinned(id: string, pinned: boolean): Promise<SavedRun | null> {
  const s = await readStore();
  const r = s.runs.find((r) => r.id === id);
  if (!r) return null;
  r.pinned = !!pinned;
  r.pinned_at = pinned ? new Date().toISOString() : null;
  await writeStore(s);
  return ensureTags(r);
}

export async function listPinnedRuns(limit = 6): Promise<SavedRun[]> {
  const s = await readStore();
  const pinned = s.runs.map(ensureTags).filter((r) => r.pinned);
  pinned.sort((a, b) => {
    const at = a.pinned_at ?? a.created_at;
    const bt = b.pinned_at ?? b.created_at;
    return at < bt ? 1 : -1;
  });
  return pinned.slice(0, Math.max(1, Math.min(limit, 50)));
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.runs)) return { runs: [] };
    // Back-fill tags on older records.
    for (const r of j.runs) ensureTags(r);
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { runs: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function genId(): string {
  // 10-char URL-safe id, ~60 bits entropy. Good enough for unguessable share links.
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

export async function listRuns(): Promise<SavedRun[]> {
  // Best-effort retention sweep so the list never serves rows past the policy
  // window. Throttled to once/hour inside the helper.
  try {
    await maybeAutoSweep();
  } catch {}
  const s = await readStore();
  return [...s.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function getRun(id: string): Promise<SavedRun | null> {
  const s = await readStore();
  return s.runs.find((r) => r.id === id) ?? null;
}

export async function createRun(
  input: Omit<SavedRun, "id" | "created_at" | "tags"> & { tags?: string[] },
): Promise<SavedRun> {
  const s = await readStore();
  const run: SavedRun = {
    ...input,
    tags: normalizeTags(input.tags ?? []),
    created_by_key_id: input.created_by_key_id ?? null,
    created_by_key_label: input.created_by_key_label ?? null,
    id: genId(),
    created_at: new Date().toISOString(),
  };
  s.runs.push(run);
  // Bound store size.
  if (s.runs.length > MAX_RUNS) {
    s.runs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    s.runs = s.runs.slice(0, MAX_RUNS);
  }
  await writeStore(s);
  return run;
}

export async function deleteRun(id: string): Promise<boolean> {
  const s = await readStore();
  const before = s.runs.length;
  s.runs = s.runs.filter((r) => r.id !== id);
  if (s.runs.length === before) return false;
  await writeStore(s);
  return true;
}

export async function renameRun(id: string, label: string): Promise<SavedRun | null> {
  const s = await readStore();
  const r = s.runs.find((r) => r.id === id);
  if (!r) return null;
  r.label = label;
  await writeStore(s);
  return ensureTags(r);
}

export async function setRunTags(id: string, tags: unknown): Promise<SavedRun | null> {
  const s = await readStore();
  const r = s.runs.find((r) => r.id === id);
  if (!r) return null;
  r.tags = normalizeTags(tags);
  await writeStore(s);
  return r;
}

export async function setRunNotes(id: string, notes: unknown): Promise<SavedRun | null> {
  const s = await readStore();
  const r = s.runs.find((r) => r.id === id);
  if (!r) return null;
  r.notes = normalizeNotes(notes);
  await writeStore(s);
  return ensureTags(r);
}

export type BulkResult = {
  requested: number;
  matched: number;
  affected: number;
  ids: string[];
};

// Apply an action to many runs in a single transaction.
// Actions: "delete" | "pin" | "unpin" | "add_tags" | "remove_tags" | "set_tags".
export async function bulkRunOp(
  ids: string[],
  action: "delete" | "pin" | "unpin" | "add_tags" | "remove_tags" | "set_tags",
  tags?: unknown,
): Promise<BulkResult> {
  const uniq = Array.from(new Set(ids.filter((v) => typeof v === "string" && v.length > 0)));
  const s = await readStore();
  const present = new Set(s.runs.map((r) => r.id));
  const matched = uniq.filter((id) => present.has(id));
  const matchedSet = new Set(matched);
  const affected: string[] = [];

  if (action === "delete") {
    const before = s.runs.length;
    s.runs = s.runs.filter((r) => !matchedSet.has(r.id));
    affected.push(...matched);
    if (s.runs.length !== before) await writeStore(s);
    return { requested: uniq.length, matched: matched.length, affected: affected.length, ids: affected };
  }

  const nowIso = new Date().toISOString();
  if (action === "pin" || action === "unpin") {
    const target = action === "pin";
    for (const r of s.runs) {
      if (!matchedSet.has(r.id)) continue;
      const cur = r.pinned === true;
      if (cur === target) continue;
      r.pinned = target;
      r.pinned_at = target ? nowIso : null;
      affected.push(r.id);
    }
    if (affected.length > 0) await writeStore(s);
    return { requested: uniq.length, matched: matched.length, affected: affected.length, ids: affected };
  }

  // Tag mutations.
  const incoming = normalizeTags(tags ?? []);
  for (const r of s.runs) {
    if (!matchedSet.has(r.id)) continue;
    const before = normalizeTags(r.tags ?? []);
    let next: string[];
    if (action === "set_tags") {
      next = incoming;
    } else if (action === "add_tags") {
      next = normalizeTags([...before, ...incoming]);
    } else {
      const drop = new Set(incoming);
      next = before.filter((t) => !drop.has(t));
    }
    const changed = before.length !== next.length || before.some((t, i) => t !== next[i]);
    if (changed) {
      r.tags = next;
      affected.push(r.id);
    }
  }
  if (affected.length > 0) await writeStore(s);
  return { requested: uniq.length, matched: matched.length, affected: affected.length, ids: affected };
}

export type TagCount = { tag: string; count: number };

export async function listTags(): Promise<TagCount[]> {
  const s = await readStore();
  const counts = new Map<string, number>();
  for (const r of s.runs) {
    for (const t of r.tags ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
}

export type QueryOpts = {
  q?: string;
  regime?: string;
  ticker?: string;
  tag?: string;
  pinned?: boolean;
  limit?: number;
  offset?: number;
};

export type QueryResult = {
  runs: SavedRun[];
  total: number;
  limit: number;
  offset: number;
};

export async function queryRuns(opts: QueryOpts = {}): Promise<QueryResult> {
  const s = await readStore();
  const q = (opts.q ?? "").trim().toLowerCase();
  const regime = (opts.regime ?? "").trim().toLowerCase();
  const ticker = (opts.ticker ?? "").trim().toUpperCase();
  const tagRaw = (opts.tag ?? "").trim().toLowerCase();
  const tag = tagRaw && TAG_RE.test(tagRaw) ? tagRaw : "";
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  let filtered = s.runs.map(ensureTags);
  if (q) {
    filtered = filtered.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.ticker.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.tags ?? []).some((t) => t.includes(q)),
    );
  }
  if (regime && regime !== "all") {
    filtered = filtered.filter(
      (r) => (r.payload.snapshot?.label ?? "").toLowerCase() === regime,
    );
  }
  if (ticker) {
    filtered = filtered.filter((r) => r.ticker.toUpperCase() === ticker);
  }
  if (tag) {
    filtered = filtered.filter((r) => (r.tags ?? []).includes(tag));
  }
  if (opts.pinned === true) {
    filtered = filtered.filter((r) => r.pinned === true);
  }
  filtered = [...filtered].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  return { runs: page, total, limit, offset };
}

// Pure CSV serializer for one or many saved runs. Each row = one bar.
export function runsToCSV(runs: SavedRun[]): string {
  const header = [
    "run_id",
    "label",
    "ticker",
    "lookback_days",
    "created_at",
    "tags",
    "regime_label",
    "confidence",
    "risk_scale",
    "bar_date",
    "close",
    "bar_regime",
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines: string[] = [header.join(",")];
  for (const r of runs) {
    const snap = r.payload.snapshot;
    const dates = r.payload.dates ?? [];
    const close = r.payload.close ?? [];
    const reg = r.payload.regime ?? [];
    const tagStr = (r.tags ?? []).join("|");
    if (dates.length === 0) {
      lines.push(
        [
          r.id,
          r.label,
          r.ticker,
          r.lookback_days,
          r.created_at,
          tagStr,
          snap?.label ?? "",
          snap?.confidence ?? "",
          snap?.risk_scale ?? "",
          "",
          "",
          "",
        ]
          .map(esc)
          .join(","),
      );
      continue;
    }
    for (let i = 0; i < dates.length; i++) {
      lines.push(
        [
          r.id,
          r.label,
          r.ticker,
          r.lookback_days,
          r.created_at,
          tagStr,
          snap?.label ?? "",
          snap?.confidence ?? "",
          snap?.risk_scale ?? "",
          dates[i],
          close[i] ?? "",
          reg[i] ?? "",
        ]
          .map(esc)
          .join(","),
      );
    }
  }
  return lines.join("\n") + "\n";
}

// Test helper: in-memory reset, only used by unit tests.
export async function _resetForTests(): Promise<void> {
  try {
    await fs.unlink(DATA_FILE);
  } catch {}
}
