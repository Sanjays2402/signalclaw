// File-backed JSON store for the user's tracked tickers (watchlist).
// Persisted at web/.data/watchlist.json with atomic writes.
// Single-user terminal model: there is one global watchlist per install.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "watchlist.json");

export const MAX_TICKERS = 100;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,15}$/;

export type WatchlistEntry = {
  ticker: string;
  added_at: string;
  note: string | null;
  target_high: number | null;
  target_low: number | null;
  last_cross: {
    side: "above_high" | "below_low";
    price: number;
    at: string;
  } | null;
};

export function normalizePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 1e6) / 1e6;
}

type Store = { entries: WatchlistEntry[] };

export function normalizeTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!t || !TICKER_RE.test(t)) return null;
  return t;
}

export function normalizeNote(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.slice(0, 200);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw) as Store;
    if (!data || !Array.isArray(data.entries)) return { entries: [] };
    data.entries = data.entries.map(migrate);
    return data;
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { entries: [] };
    throw e;
  }
}

async function writeStore(store: Store): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function migrate(entry: any): WatchlistEntry {
  return {
    ticker: entry.ticker,
    added_at: entry.added_at,
    note: entry.note ?? null,
    target_high: typeof entry.target_high === "number" ? entry.target_high : null,
    target_low: typeof entry.target_low === "number" ? entry.target_low : null,
    last_cross: entry.last_cross ?? null,
  };
}

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const { entries } = await readStore();
  return entries.map(migrate);
}

export async function setTargets(
  ticker: string,
  target_high: number | null,
  target_low: number | null,
): Promise<WatchlistEntry | null> {
  const t = normalizeTicker(ticker);
  if (!t) return null;
  const store = await readStore();
  const entry = store.entries.find((e) => e.ticker === t);
  if (!entry) return null;
  if (target_high !== null && target_low !== null && target_low >= target_high) {
    throw new Error("low_above_high");
  }
  entry.target_high = target_high;
  entry.target_low = target_low;
  // Clear previous cross when bounds change so a fresh check fires.
  entry.last_cross = null;
  await writeStore(store);
  return migrate(entry);
}

export async function recordCross(
  ticker: string,
  cross: WatchlistEntry["last_cross"],
): Promise<WatchlistEntry | null> {
  const t = normalizeTicker(ticker);
  if (!t) return null;
  const store = await readStore();
  const entry = store.entries.find((e) => e.ticker === t);
  if (!entry) return null;
  entry.last_cross = cross;
  await writeStore(store);
  return migrate(entry);
}

export async function addTicker(ticker: string, note: string | null = null): Promise<WatchlistEntry> {
  const t = normalizeTicker(ticker);
  if (!t) throw new Error("invalid_ticker");
  const store = await readStore();
  if (store.entries.length >= MAX_TICKERS) {
    throw new Error("limit_reached");
  }
  const existing = store.entries.find((e) => e.ticker === t);
  if (existing) {
    if (note !== null) existing.note = note;
    await writeStore(store);
    return existing;
  }
  const entry: WatchlistEntry = {
    ticker: t,
    added_at: new Date().toISOString(),
    note,
    target_high: null,
    target_low: null,
    last_cross: null,
  };
  // Newest first
  store.entries.unshift(entry);
  await writeStore(store);
  return entry;
}

// Parse a bulk-import string. Accepts comma, whitespace, newline, semicolon
// or tab separated tickers. Returns the deduped, uppercased input tokens
// along with any tokens that failed normalization so the caller can report
// invalid rows without aborting the whole batch.
export function parseBulkTickers(
  raw: string | string[] | unknown,
): { tickers: string[]; invalid: string[] } {
  let tokens: string[] = [];
  if (Array.isArray(raw)) {
    tokens = raw.flatMap((v) => (typeof v === "string" ? v.split(/[\s,;]+/) : []));
  } else if (typeof raw === "string") {
    tokens = raw.split(/[\s,;]+/);
  }
  const seen = new Set<string>();
  const tickers: string[] = [];
  const invalid: string[] = [];
  for (const tok of tokens) {
    const trimmed = tok.trim();
    if (!trimmed) continue;
    const norm = normalizeTicker(trimmed);
    if (!norm) {
      if (!invalid.includes(trimmed)) invalid.push(trimmed);
      continue;
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    tickers.push(norm);
  }
  return { tickers, invalid };
}

export type BulkAddResult = {
  added: WatchlistEntry[];
  skipped_existing: string[];
  skipped_limit: string[];
  invalid: string[];
};

// Bulk add tickers. Already-present tickers are reported as skipped_existing
// (and never have their note overwritten by an empty bulk row). Tickers that
// would overflow MAX_TICKERS are reported as skipped_limit so the caller can
// surface a precise message instead of failing the whole batch.
export async function addTickersBulk(
  raw: string | string[] | unknown,
): Promise<BulkAddResult> {
  const { tickers, invalid } = parseBulkTickers(raw);
  const store = await readStore();
  const present = new Set(store.entries.map((e) => e.ticker));
  const added: WatchlistEntry[] = [];
  const skipped_existing: string[] = [];
  const skipped_limit: string[] = [];
  for (const t of tickers) {
    if (present.has(t)) {
      skipped_existing.push(t);
      continue;
    }
    if (store.entries.length >= MAX_TICKERS) {
      skipped_limit.push(t);
      continue;
    }
    const entry: WatchlistEntry = {
      ticker: t,
      added_at: new Date().toISOString(),
      note: null,
      target_high: null,
      target_low: null,
      last_cross: null,
    };
    store.entries.unshift(entry);
    present.add(t);
    added.push(entry);
  }
  if (added.length > 0) await writeStore(store);
  return { added, skipped_existing, skipped_limit, invalid };
}

export async function removeTicker(ticker: string): Promise<boolean> {
  const t = normalizeTicker(ticker);
  if (!t) return false;
  const store = await readStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.ticker !== t);
  if (store.entries.length === before) return false;
  await writeStore(store);
  return true;
}

export async function updateNote(ticker: string, note: string | null): Promise<WatchlistEntry | null> {
  const t = normalizeTicker(ticker);
  if (!t) return null;
  const store = await readStore();
  const entry = store.entries.find((e) => e.ticker === t);
  if (!entry) return null;
  entry.note = note;
  await writeStore(store);
  return entry;
}

// JSON export bundles the entries with an exported_at stamp and a count so
// downstream tools can tell when the snapshot was taken without parsing
// filenames. Shape is intentionally distinct from the back-compat list
// response (which still wraps tickers + entries for legacy clients).
export function entriesToJSON(entries: WatchlistEntry[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export function entriesToCSV(entries: WatchlistEntry[]): string {
  const header = "ticker,added_at,note,target_low,target_high";
  const lines = entries.map((e) => {
    const note = (e.note ?? "").replace(/"/g, '""');
    const lo = e.target_low ?? "";
    const hi = e.target_high ?? "";
    return `${e.ticker},${e.added_at},"${note}",${lo},${hi}`;
  });
  return [header, ...lines].join("\n") + "\n";
}

// Markdown export mirrors the CSV columns as a GitHub-flavored table so the
// watchlist can be pasted into a journal, an issue, or a chat the same way
// /history, /compare, and shared run pages already support.
export function entriesToMarkdown(entries: WatchlistEntry[]): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const head = [
    `# SignalClaw watchlist`,
    ``,
    `Exported ${stamp} · ${entries.length} ticker${entries.length === 1 ? "" : "s"}`,
    ``,
  ];
  if (entries.length === 0) {
    return head.concat([`_No tickers tracked yet._`, ``]).join("\n");
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const fmtNum = (n: number | null) => (n === null || n === undefined ? "" : String(n));
  const table = [
    `| Ticker | Added | Target low | Target high | Note | Last cross |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const e of entries) {
    const added = (e.added_at || "").slice(0, 10);
    const cross = e.last_cross
      ? `${e.last_cross.side === "above_high" ? "above" : "below"} @ ${e.last_cross.price} on ${(e.last_cross.at || "").slice(0, 10)}`
      : "";
    table.push(
      `| ${esc(e.ticker)} | ${added} | ${fmtNum(e.target_low)} | ${fmtNum(e.target_high)} | ${esc(e.note ?? "")} | ${esc(cross)} |`,
    );
  }
  return head.concat(table, [""]).join("\n");
}
