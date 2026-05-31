// Per-API-key monthly request quota.
//
// Real wiring. Rate limits stop bursts (per-minute window) but do nothing
// against a steady client that quietly burns through a contract's monthly
// allowance. This store is what enterprise procurement actually asks for:
// a hard, per-key, calendar-month cap on /api/v1/* requests, with operator
// override, structured audit on block, and standard quota headers the
// caller can read.
//
// On allow: counter increments and X-Quota-* headers ship on the response.
// On block: v1Guard returns 429 { code: "monthly_quota_exceeded" } before
// the rate limiter is consulted, and the request is recorded in the audit
// log so SOC2 reviewers can see who hit the ceiling and when.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoredKey } from "./keyStore";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "monthly-quotas.json");

// 0 = unlimited (no cap enforced). Operators opt-in per key, or set a
// global default via SIGNALCLAW_MONTHLY_QUOTA. Default is unlimited so
// upgrading an existing install does not surprise anyone.
export const DEFAULT_MONTHLY_QUOTA = (() => {
  const raw = typeof process !== "undefined"
    ? process.env.SIGNALCLAW_MONTHLY_QUOTA
    : undefined;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

type Counter = {
  period: string; // "YYYY-MM" UTC
  count: number;
};

type Store = {
  // override per key id; missing = default (0 = unlimited)
  quotas: Record<string, number>;
  counters: Record<string, Counter>;
};

let cache: Store | null = null;
let flushing: Promise<void> | null = null;
let pending = false;

async function readStore(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    cache = {
      quotas: (j && j.quotas) || {},
      counters: (j && j.counters) || {},
    };
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    cache = { quotas: {}, counters: {} };
  }
  return cache;
}

async function flush(): Promise<void> {
  if (!cache) return;
  // Serialize disk writes so concurrent reserve() calls don't race on the
  // tmp -> final rename (which fails ENOENT when two writers overlap).
  if (flushing) {
    pending = true;
    return flushing;
  }
  flushing = (async () => {
    try {
      do {
        pending = false;
        await fs.mkdir(DATA_DIR, { recursive: true });
        const tmp = DATA_FILE + "." + process.pid + ".tmp";
        await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
        await fs.rename(tmp, DATA_FILE);
      } while (pending);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function _resetForTests(): void {
  cache = null;
}

export function periodOf(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function nextPeriodResetIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString();
}

export type QuotaDecision = {
  allowed: boolean;
  unlimited: boolean;
  limit: number; // 0 when unlimited
  used: number; // count after increment if allowed, else current count
  remaining: number; // 0 when blocked or unlimited (Infinity collapsed to 0 in header)
  period: string;
  reset_at: string; // ISO 8601 UTC start of next calendar month
};

export async function getQuotaForKey(keyId: string): Promise<number> {
  const s = await readStore();
  return s.quotas[keyId] ?? DEFAULT_MONTHLY_QUOTA;
}

export async function setQuotaForKey(
  keyId: string,
  quota: number | null,
): Promise<number> {
  const s = await readStore();
  if (quota === null) {
    delete s.quotas[keyId];
  } else {
    if (!Number.isFinite(quota) || quota < 0 || quota > 100_000_000) {
      throw new Error("quota must be between 0 and 100000000");
    }
    s.quotas[keyId] = Math.floor(quota);
  }
  await flush();
  return s.quotas[keyId] ?? DEFAULT_MONTHLY_QUOTA;
}

export async function getUsage(
  keyId: string,
  now: Date = new Date(),
): Promise<{ period: string; count: number }> {
  const s = await readStore();
  const period = periodOf(now);
  const cur = s.counters[keyId];
  if (!cur || cur.period !== period) return { period, count: 0 };
  return { period, count: cur.count };
}

// Reserve one request slot. Returns a decision the caller turns into
// headers and (when blocked) a 429. Increments the counter on allow.
export async function reserve(
  key: Pick<StoredKey, "id">,
  now: Date = new Date(),
): Promise<QuotaDecision> {
  const s = await readStore();
  const limit = s.quotas[key.id] ?? DEFAULT_MONTHLY_QUOTA;
  const period = periodOf(now);
  const reset_at = nextPeriodResetIso(now);
  const cur = s.counters[key.id];
  const count = cur && cur.period === period ? cur.count : 0;

  if (limit === 0) {
    // Unlimited: still keep the running count so operators can observe
    // it via the admin endpoint, but never block.
    s.counters[key.id] = { period, count: count + 1 };
    flush().catch(() => {});
    return {
      allowed: true,
      unlimited: true,
      limit: 0,
      used: count + 1,
      remaining: 0,
      period,
      reset_at,
    };
  }

  if (count >= limit) {
    return {
      allowed: false,
      unlimited: false,
      limit,
      used: count,
      remaining: 0,
      period,
      reset_at,
    };
  }
  s.counters[key.id] = { period, count: count + 1 };
  flush().catch(() => {});
  return {
    allowed: true,
    unlimited: false,
    limit,
    used: count + 1,
    remaining: Math.max(0, limit - (count + 1)),
    period,
    reset_at,
  };
}

export function applyQuotaHeaders(headers: Headers, d: QuotaDecision): void {
  if (d.unlimited) {
    headers.set("X-Quota-Limit", "unlimited");
    headers.set("X-Quota-Used", String(d.used));
    headers.set("X-Quota-Remaining", "unlimited");
  } else {
    headers.set("X-Quota-Limit", String(d.limit));
    headers.set("X-Quota-Used", String(d.used));
    headers.set("X-Quota-Remaining", String(Math.max(0, d.remaining)));
  }
  headers.set("X-Quota-Period", d.period);
  headers.set("X-Quota-Reset", d.reset_at);
}
