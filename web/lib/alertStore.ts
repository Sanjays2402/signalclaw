// File-backed alert store. Persists user-armed price/percent alerts and the
// history of fires under web/.data/alerts.json. Single-user terminal model,
// same pattern as watchlistStore and runStore.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "alerts.json");

export const MAX_ALERTS = 200;
export const MAX_HISTORY = 1000;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,15}$/;

export const CONDITIONS = [
  "price_above",
  "price_below",
  "pct_change_above",
  "pct_change_below",
] as const;
export type Condition = (typeof CONDITIONS)[number];

export type Alert = {
  id: string;
  ticker: string;
  condition: Condition;
  value: number;
  note: string;
  cooldown_hours: number;
  enabled: boolean;
  last_fired_at: string | null;
  created_at: string;
};

export type AlertEvent = {
  alert_id: string;
  ticker: string;
  condition: Condition;
  value: number;
  observed: number;
  fired_at: string;
  note: string;
};

type Store = { alerts: Alert[]; history: AlertEvent[] };

function isCondition(x: unknown): x is Condition {
  return typeof x === "string" && (CONDITIONS as readonly string[]).includes(x);
}

export function normalizeTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  if (!t || !TICKER_RE.test(t)) return null;
  return t;
}

export function normalizeNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 200);
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw) as Store;
    return {
      alerts: Array.isArray(data?.alerts) ? data.alerts : [],
      history: Array.isArray(data?.history) ? data.history : [],
    };
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { alerts: [], history: [] };
    throw e;
  }
}

async function writeStore(store: Store): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

export async function listAlerts(): Promise<Alert[]> {
  const { alerts } = await readStore();
  return alerts.slice();
}

export type AlertInput = {
  ticker: unknown;
  condition: unknown;
  value: unknown;
  note?: unknown;
  cooldown_hours?: unknown;
  enabled?: unknown;
};

export type ValidationError = { code: string; message: string };

export function validateInput(body: AlertInput):
  | { ok: true; data: Omit<Alert, "id" | "last_fired_at" | "created_at"> }
  | { ok: false; err: ValidationError } {
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return { ok: false, err: { code: "bad_ticker", message: "ticker must be 1 to 16 chars, A-Z, 0-9, dot or dash" } };
  if (!isCondition(body.condition)) {
    return { ok: false, err: { code: "bad_condition", message: `condition must be one of ${CONDITIONS.join(", ")}` } };
  }
  const value = typeof body.value === "number" ? body.value : parseFloat(String(body.value));
  if (!Number.isFinite(value)) {
    return { ok: false, err: { code: "bad_value", message: "value must be a finite number" } };
  }
  if (body.condition.startsWith("price") && value <= 0) {
    return { ok: false, err: { code: "bad_value", message: "price targets must be positive" } };
  }
  const cooldown_raw = body.cooldown_hours;
  const cooldown_hours =
    cooldown_raw === undefined || cooldown_raw === null || cooldown_raw === ""
      ? 12
      : Math.max(0, Math.floor(Number(cooldown_raw)));
  if (!Number.isFinite(cooldown_hours)) {
    return { ok: false, err: { code: "bad_cooldown", message: "cooldown_hours must be a non-negative integer" } };
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  return {
    ok: true,
    data: {
      ticker,
      condition: body.condition,
      value,
      note: normalizeNote(body.note),
      cooldown_hours,
      enabled,
    },
  };
}

export async function createAlert(input: AlertInput): Promise<{ ok: true; alert: Alert } | { ok: false; err: ValidationError; status: number }> {
  const v = validateInput(input);
  if (!v.ok) return { ok: false, err: v.err, status: 400 };
  const store = await readStore();
  if (store.alerts.length >= MAX_ALERTS) {
    return { ok: false, err: { code: "limit_reached", message: `alert limit is ${MAX_ALERTS}` }, status: 409 };
  }
  const alert: Alert = {
    id: crypto.randomUUID(),
    ...v.data,
    last_fired_at: null,
    created_at: new Date().toISOString(),
  };
  store.alerts.push(alert);
  await writeStore(store);
  return { ok: true, alert };
}

export async function deleteAlert(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.alerts.length;
  store.alerts = store.alerts.filter((a) => a.id !== id);
  if (store.alerts.length === before) return false;
  await writeStore(store);
  return true;
}

export async function listHistory(opts: { ticker?: string; limit: number; offset: number }):
  Promise<{ total: number; limit: number; offset: number; events: AlertEvent[] }> {
  const { history } = await readStore();
  const filtered = opts.ticker
    ? history.filter((e) => e.ticker === opts.ticker)
    : history;
  const sorted = filtered.slice().sort((a, b) => b.fired_at.localeCompare(a.fired_at));
  return {
    total: sorted.length,
    limit: opts.limit,
    offset: opts.offset,
    events: sorted.slice(opts.offset, opts.offset + opts.limit),
  };
}

export async function clearHistory(): Promise<number> {
  const store = await readStore();
  const n = store.history.length;
  store.history = [];
  await writeStore(store);
  return n;
}

// Deterministic synthetic quote for tickers when no live price source is wired.
// Stable within an hour so cooldowns behave sensibly across consecutive checks.
function syntheticQuote(ticker: string, anchor: number | null): { last: number; prev: number } {
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const h = crypto.createHash("sha256").update(`${ticker}|${bucket}`).digest();
  // Normalize two bytes to [-1, 1] for drift, one for base scatter.
  const drift = ((h.readUInt16BE(0) / 0xffff) * 2 - 1) * 0.04; // +-4%
  const base = anchor && anchor > 0 ? anchor : 50 + (h[2] % 200);
  const prev = base;
  const last = Math.max(0.01, base * (1 + drift));
  return { last: Number(last.toFixed(4)), prev: Number(prev.toFixed(4)) };
}

export type CheckHit = {
  alert_id: string;
  ticker: string;
  condition: Condition;
  value: number;
  observed: number;
  fired_at: string;
  note: string;
};

export async function runCheck(prices?: Record<string, number>):
  Promise<{ hits: CheckHit[]; checked: number; quotes: Record<string, { last: number; prev: number }> }> {
  const store = await readStore();
  const now = new Date();
  const nowIso = now.toISOString();
  const quotes: Record<string, { last: number; prev: number }> = {};
  const hits: CheckHit[] = [];

  function quoteFor(ticker: string, anchor: number | null): { last: number; prev: number } {
    if (quotes[ticker]) return quotes[ticker];
    if (prices && Number.isFinite(prices[ticker])) {
      const last = Number(prices[ticker]);
      quotes[ticker] = { last, prev: anchor && anchor > 0 ? anchor : last };
    } else {
      quotes[ticker] = syntheticQuote(ticker, anchor);
    }
    return quotes[ticker];
  }

  let mutated = false;
  for (const a of store.alerts) {
    if (!a.enabled) continue;
    // Cooldown gate.
    if (a.last_fired_at) {
      const last = Date.parse(a.last_fired_at);
      if (Number.isFinite(last) && now.getTime() - last < a.cooldown_hours * 3600 * 1000) {
        continue;
      }
    }
    const isPct = a.condition.startsWith("pct");
    const q = quoteFor(a.ticker, isPct ? null : a.value);
    let observed: number;
    let fires = false;
    if (a.condition === "price_above") {
      observed = q.last;
      fires = q.last > a.value;
    } else if (a.condition === "price_below") {
      observed = q.last;
      fires = q.last < a.value;
    } else {
      const pct = q.prev > 0 ? (q.last - q.prev) / q.prev : 0;
      observed = pct;
      fires = a.condition === "pct_change_above" ? pct > a.value : pct < a.value;
    }
    if (!fires) continue;
    const event: AlertEvent = {
      alert_id: a.id,
      ticker: a.ticker,
      condition: a.condition,
      value: a.value,
      observed,
      fired_at: nowIso,
      note: a.note,
    };
    store.history.unshift(event);
    if (store.history.length > MAX_HISTORY) store.history.length = MAX_HISTORY;
    a.last_fired_at = nowIso;
    hits.push(event);
    mutated = true;
  }
  if (mutated) await writeStore(store);
  return { hits, checked: store.alerts.length, quotes };
}
