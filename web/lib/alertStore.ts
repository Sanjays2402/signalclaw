// File-backed alert store. Persists user-armed price/percent alerts and the
// history of fires under web/.data/alerts.json.
//
// Multi-tenancy: alerts and history live under per-owner buckets keyed by an
// opaque ownerId (typically a StoredKey.id from keyStore). Callers without
// an authenticated key (the legacy cookie-session /api/alerts surface) land
// in the OPERATOR bucket. Legacy single-tenant payloads (top-level
// { alerts, history }) are migrated on first read into the OPERATOR bucket
// so installs upgrade in place without losing data.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "alerts.json");

export const MAX_ALERTS = 200;
export const MAX_HISTORY = 1000;
export const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,15}$/;
export const OPERATOR_OWNER_ID = "__operator__";

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

type TenantBucket = { alerts: Alert[]; history: AlertEvent[] };
type Store = { tenants: Record<string, TenantBucket> };

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

function normalizeOwnerId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return OPERATOR_OWNER_ID;
  const t = raw.trim();
  if (!t) return OPERATOR_OWNER_ID;
  return t.slice(0, 128);
}

function emptyBucket(): TenantBucket {
  return { alerts: [], history: [] };
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw) as any;
    // Migrate legacy { alerts, history } -> { tenants: { __operator__: ... } }
    if (data && Array.isArray(data.alerts) && !data.tenants) {
      return {
        tenants: {
          [OPERATOR_OWNER_ID]: {
            alerts: data.alerts,
            history: Array.isArray(data.history) ? data.history : [],
          },
        },
      };
    }
    const tenants: Record<string, TenantBucket> = {};
    if (data && typeof data.tenants === "object" && data.tenants !== null) {
      for (const [k, v] of Object.entries<any>(data.tenants)) {
        tenants[k] = {
          alerts: Array.isArray(v?.alerts) ? v.alerts : [],
          history: Array.isArray(v?.history) ? v.history : [],
        };
      }
    }
    return { tenants };
  } catch (e: any) {
    if (e && e.code === "ENOENT") return { tenants: {} };
    throw e;
  }
}

async function writeStore(store: Store): Promise<void> {
  await ensureDir();
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function bucketFor(store: Store, ownerId: string): TenantBucket {
  if (!store.tenants[ownerId]) store.tenants[ownerId] = emptyBucket();
  return store.tenants[ownerId];
}

export async function listAlerts(ownerId?: string | null): Promise<Alert[]> {
  const oid = normalizeOwnerId(ownerId);
  const store = await readStore();
  const b = store.tenants[oid];
  return b ? b.alerts.slice() : [];
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

export async function createAlert(
  input: AlertInput,
  ownerId?: string | null,
): Promise<{ ok: true; alert: Alert } | { ok: false; err: ValidationError; status: number }> {
  const v = validateInput(input);
  if (!v.ok) return { ok: false, err: v.err, status: 400 };
  const oid = normalizeOwnerId(ownerId);
  const store = await readStore();
  const bucket = bucketFor(store, oid);
  if (bucket.alerts.length >= MAX_ALERTS) {
    return { ok: false, err: { code: "limit_reached", message: `alert limit is ${MAX_ALERTS}` }, status: 409 };
  }
  const alert: Alert = {
    id: crypto.randomUUID(),
    ...v.data,
    last_fired_at: null,
    created_at: new Date().toISOString(),
  };
  bucket.alerts.push(alert);
  await writeStore(store);
  return { ok: true, alert };
}

export async function setAlertEnabled(
  id: string,
  enabled: boolean,
  ownerId?: string | null,
): Promise<Alert | null> {
  const oid = normalizeOwnerId(ownerId);
  const store = await readStore();
  const bucket = store.tenants[oid];
  if (!bucket) return null;
  const alert = bucket.alerts.find((a) => a.id === id);
  if (!alert) return null;
  if (alert.enabled === enabled) return alert;
  alert.enabled = enabled;
  await writeStore(store);
  return alert;
}

export async function deleteAlert(id: string, ownerId?: string | null): Promise<boolean> {
  const oid = normalizeOwnerId(ownerId);
  const store = await readStore();
  const bucket = store.tenants[oid];
  if (!bucket) return false;
  const before = bucket.alerts.length;
  bucket.alerts = bucket.alerts.filter((a) => a.id !== id);
  if (bucket.alerts.length === before) return false;
  await writeStore(store);
  return true;
}

export async function listHistory(opts: { ticker?: string; limit: number; offset: number; ownerId?: string | null }):
  Promise<{ total: number; limit: number; offset: number; events: AlertEvent[] }> {
  const oid = normalizeOwnerId(opts.ownerId);
  const store = await readStore();
  const history = store.tenants[oid]?.history ?? [];
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

// listAllHistory returns every event for export, ignoring the paginated
// limit/offset that drives the on-screen table. The ticker filter still
// applies so users get exactly what they see in the UI when a filter is set.
export async function listAllHistory(opts: { ticker?: string; ownerId?: string | null }):
  Promise<AlertEvent[]> {
  const oid = normalizeOwnerId(opts.ownerId);
  const store = await readStore();
  const history = store.tenants[oid]?.history ?? [];
  const filtered = opts.ticker
    ? history.filter((e) => e.ticker === opts.ticker)
    : history;
  return filtered.slice().sort((a, b) => b.fired_at.localeCompare(a.fired_at));
}

function csvEscape(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function eventsToCSV(events: AlertEvent[]): string {
  const header = "fired_at,ticker,condition,value,observed,alert_id,note";
  const lines = events.map((e) =>
    [
      e.fired_at,
      e.ticker,
      e.condition,
      String(e.value),
      String(e.observed),
      e.alert_id,
      csvEscape(e.note ?? ""),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export function eventsToJSON(events: AlertEvent[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: events.length,
    events,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

export async function clearHistory(ownerId?: string | null): Promise<number> {
  const oid = normalizeOwnerId(ownerId);
  const store = await readStore();
  const bucket = store.tenants[oid];
  if (!bucket) return 0;
  const n = bucket.history.length;
  bucket.history = [];
  await writeStore(store);
  return n;
}

// Admin-only aggregate view of every tenant bucket. Used by
// /api/admin/alerts so ops can audit cross-tenant footprint without
// leaking individual bucket contents into v1 callers.
export async function listTenantSummary(): Promise<{
  tenants: { owner_id: string; alert_count: number; history_count: number; armed: number }[];
  total_alerts: number;
  total_history: number;
}> {
  const store = await readStore();
  const tenants = Object.entries(store.tenants).map(([owner_id, b]) => ({
    owner_id,
    alert_count: b.alerts.length,
    history_count: b.history.length,
    armed: b.alerts.filter((a) => a.enabled).length,
  }));
  tenants.sort((a, b) => a.owner_id.localeCompare(b.owner_id));
  return {
    tenants,
    total_alerts: tenants.reduce((n, t) => n + t.alert_count, 0),
    total_history: tenants.reduce((n, t) => n + t.history_count, 0),
  };
}

// Deterministic synthetic quote for tickers when no live price source is wired.
// Stable within an hour so cooldowns behave sensibly across consecutive checks.
function syntheticQuote(ticker: string, anchor: number | null): { last: number; prev: number } {
  const bucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const h = crypto.createHash("sha256").update(`${ticker}|${bucket}`).digest();
  const drift = ((h.readUInt16BE(0) / 0xffff) * 2 - 1) * 0.04;
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

export async function runCheck(
  prices?: Record<string, number>,
  opts?: { dryRun?: boolean; ownerId?: string | null },
): Promise<{ hits: CheckHit[]; checked: number; quotes: Record<string, { last: number; prev: number }> }> {
  const oid = normalizeOwnerId(opts?.ownerId);
  const store = await readStore();
  const bucket = bucketFor(store, oid);
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
  for (const a of bucket.alerts) {
    if (!a.enabled) continue;
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
    bucket.history.unshift(event);
    if (bucket.history.length > MAX_HISTORY) bucket.history.length = MAX_HISTORY;
    a.last_fired_at = nowIso;
    hits.push(event);
    mutated = true;
  }
  if (mutated && !opts?.dryRun) await writeStore(store);
  return { hits, checked: bucket.alerts.length, quotes };
}
