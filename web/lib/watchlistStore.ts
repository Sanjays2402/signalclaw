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
};

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

export async function listWatchlist(): Promise<WatchlistEntry[]> {
  const { entries } = await readStore();
  return entries.slice();
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
  };
  // Newest first
  store.entries.unshift(entry);
  await writeStore(store);
  return entry;
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

export function entriesToCSV(entries: WatchlistEntry[]): string {
  const header = "ticker,added_at,note";
  const lines = entries.map((e) => {
    const note = (e.note ?? "").replace(/"/g, '""');
    return `${e.ticker},${e.added_at},"${note}"`;
  });
  return [header, ...lines].join("\n") + "\n";
}
