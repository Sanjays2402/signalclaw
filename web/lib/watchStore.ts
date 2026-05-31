// File-backed store for scheduled regime watches.
// A watch defines {ticker, lookback_days, cadence_hours}. The cron endpoint
// classifies due watches, saves a SavedRun, and stamps last_run.
// Persisted at web/.data/watches.json with atomic writes. Same single-tenant
// pattern as alertStore / watchlistStore / runStore.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "watches.json");

export const MAX_WATCHES = 50;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,15}$/;
export const CADENCES = [1, 4, 12, 24, 168] as const;
export type Cadence = (typeof CADENCES)[number];
export const MIN_LOOKBACK = 30;
export const MAX_LOOKBACK = 365;

export type Watch = {
  id: string;
  ticker: string;
  lookback_days: number;
  cadence_hours: Cadence;
  enabled: boolean;
  label: string;
  created_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  last_regime: string | null;
  last_error: string | null;
  runs_count: number;
};

type Store = { watches: Watch[] };

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readAll(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.watches)) return parsed as Store;
  } catch {}
  return { watches: [] };
}

async function writeAll(store: Store): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export function normalizeLabel(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 80);
}

type CreateInput = {
  ticker?: unknown;
  lookback_days?: unknown;
  cadence_hours?: unknown;
  label?: unknown;
  enabled?: unknown;
};

export type CreateResult =
  | { ok: true; watch: Watch }
  | { ok: false; status: number; err: { code: string; message: string } };

function validate(input: CreateInput): { ok: true; v: Omit<Watch, "id" | "created_at" | "last_run_at" | "last_run_id" | "last_regime" | "last_error" | "runs_count"> } | { ok: false; code: string; message: string } {
  const tickerRaw = typeof input.ticker === "string" ? input.ticker.trim().toUpperCase() : "";
  if (!TICKER_RE.test(tickerRaw)) {
    return { ok: false, code: "bad_ticker", message: "ticker must match ^[A-Z][A-Z0-9.\\-]{0,15}$" };
  }
  const lookback = Number(input.lookback_days);
  if (!Number.isFinite(lookback) || !Number.isInteger(lookback) || lookback < MIN_LOOKBACK || lookback > MAX_LOOKBACK) {
    return { ok: false, code: "bad_lookback", message: `lookback_days must be int in [${MIN_LOOKBACK},${MAX_LOOKBACK}]` };
  }
  const cadence = Number(input.cadence_hours);
  if (!(CADENCES as readonly number[]).includes(cadence)) {
    return { ok: false, code: "bad_cadence", message: `cadence_hours must be one of ${CADENCES.join(",")}` };
  }
  const label = normalizeLabel(input.label) || `watch ${tickerRaw}`;
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  return {
    ok: true,
    v: { ticker: tickerRaw, lookback_days: lookback, cadence_hours: cadence as Cadence, label, enabled },
  };
}

export async function createWatch(input: CreateInput): Promise<CreateResult> {
  const v = validate(input);
  if (!v.ok) return { ok: false, status: 400, err: { code: v.code, message: v.message } };
  const store = await readAll();
  if (store.watches.length >= MAX_WATCHES) {
    return { ok: false, status: 409, err: { code: "limit_reached", message: `max ${MAX_WATCHES} watches` } };
  }
  const dup = store.watches.find(
    (w) => w.ticker === v.v.ticker && w.lookback_days === v.v.lookback_days && w.cadence_hours === v.v.cadence_hours,
  );
  if (dup) {
    return { ok: false, status: 409, err: { code: "duplicate", message: "watch with same ticker, lookback, and cadence exists" } };
  }
  const watch: Watch = {
    id: crypto.randomBytes(8).toString("hex"),
    ...v.v,
    created_at: new Date().toISOString(),
    last_run_at: null,
    last_run_id: null,
    last_regime: null,
    last_error: null,
    runs_count: 0,
  };
  store.watches.unshift(watch);
  await writeAll(store);
  return { ok: true, watch };
}

export async function listWatches(): Promise<Watch[]> {
  const store = await readAll();
  return store.watches;
}

export async function getWatch(id: string): Promise<Watch | null> {
  const store = await readAll();
  return store.watches.find((w) => w.id === id) ?? null;
}

export async function deleteWatch(id: string): Promise<boolean> {
  const store = await readAll();
  const idx = store.watches.findIndex((w) => w.id === id);
  if (idx === -1) return false;
  store.watches.splice(idx, 1);
  await writeAll(store);
  return true;
}

export async function setEnabled(id: string, enabled: boolean): Promise<Watch | null> {
  const store = await readAll();
  const w = store.watches.find((x) => x.id === id);
  if (!w) return null;
  w.enabled = Boolean(enabled);
  await writeAll(store);
  return w;
}

export function isDue(w: Watch, now: Date = new Date()): boolean {
  if (!w.enabled) return false;
  if (!w.last_run_at) return true;
  const last = Date.parse(w.last_run_at);
  if (!Number.isFinite(last)) return true;
  const dueAt = last + w.cadence_hours * 3600_000;
  return now.getTime() >= dueAt;
}

export async function recordRunResult(
  id: string,
  res: { run_id: string | null; regime: string | null; error: string | null; at?: string },
): Promise<Watch | null> {
  const store = await readAll();
  const w = store.watches.find((x) => x.id === id);
  if (!w) return null;
  w.last_run_at = res.at ?? new Date().toISOString();
  w.last_run_id = res.run_id;
  w.last_regime = res.regime;
  w.last_error = res.error;
  if (res.run_id) w.runs_count += 1;
  await writeAll(store);
  return w;
}
