// Per-key rate limiter for v1 API routes.
//
// Real wiring: file-backed sliding-window counters keyed by api-key id, with
// standard rate-limit headers (X-RateLimit-Limit, X-RateLimit-Remaining,
// X-RateLimit-Reset, Retry-After) and a 429 response shape that enterprise
// HTTP clients already understand.
//
// Limits are configurable per key (overrides) with sane defaults pulled from
// env. The window is a fixed 60-second bucket; in-process cache avoids
// disk thrash, and the JSON file makes limits + overrides survive restarts.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoredKey } from "./keyStore";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "ratelimits.json");

export const WINDOW_SECONDS = 60;

export const DEFAULT_PER_MINUTE = (() => {
  const raw = typeof process !== "undefined"
    ? process.env.SIGNALCLAW_RATE_LIMIT_PER_MIN
    : undefined;
  if (!raw) return 60;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
})();

type Counter = {
  window_start: number; // unix seconds, floor of (now / WINDOW_SECONDS)
  count: number;
};

type Store = {
  // override per key id; missing = default
  limits: Record<string, number>;
  // current counters per key id
  counters: Record<string, Counter>;
};

let cache: Store | null = null;
let writeQueued = false;

async function readStore(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    cache = {
      limits: (j && j.limits) || {},
      counters: (j && j.counters) || {},
    };
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    cache = { limits: {}, counters: {} };
  }
  return cache;
}

async function flush(): Promise<void> {
  if (writeQueued || !cache) return;
  writeQueued = true;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.rename(tmp, DATA_FILE);
  } finally {
    writeQueued = false;
  }
}

export function _resetForTests(): void {
  cache = null;
}

export type RateDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset_at: number; // unix seconds when window rolls
  retry_after: number; // seconds until next window when blocked, else 0
  window_start: number;
  used: number;
};

export async function getLimitForKey(keyId: string): Promise<number> {
  const s = await readStore();
  return s.limits[keyId] ?? DEFAULT_PER_MINUTE;
}

export async function setLimitForKey(
  keyId: string,
  limit: number | null,
): Promise<number> {
  const s = await readStore();
  if (limit === null) {
    delete s.limits[keyId];
  } else {
    if (!Number.isFinite(limit) || limit < 1 || limit > 100000) {
      throw new Error("limit must be between 1 and 100000");
    }
    s.limits[keyId] = Math.floor(limit);
  }
  await flush();
  return s.limits[keyId] ?? DEFAULT_PER_MINUTE;
}

export async function getCounter(keyId: string, now: Date = new Date()): Promise<Counter> {
  const s = await readStore();
  const nowSec = Math.floor(now.getTime() / 1000);
  const windowStart = nowSec - (nowSec % WINDOW_SECONDS);
  const cur = s.counters[keyId];
  if (!cur || cur.window_start !== windowStart) {
    return { window_start: windowStart, count: 0 };
  }
  return cur;
}

// Consume one request slot for this key. Returns a decision the caller can
// translate into headers and (when blocked) a 429 response.
export async function consume(
  key: Pick<StoredKey, "id">,
  now: Date = new Date(),
): Promise<RateDecision> {
  const s = await readStore();
  const limit = s.limits[key.id] ?? DEFAULT_PER_MINUTE;
  const nowSec = Math.floor(now.getTime() / 1000);
  const windowStart = nowSec - (nowSec % WINDOW_SECONDS);
  const cur = s.counters[key.id];
  let count = 0;
  if (cur && cur.window_start === windowStart) {
    count = cur.count;
  }
  const resetAt = windowStart + WINDOW_SECONDS;
  if (count >= limit) {
    // Persist nothing on block; counter is already at cap.
    return {
      allowed: false,
      limit,
      remaining: 0,
      reset_at: resetAt,
      retry_after: Math.max(1, resetAt - nowSec),
      window_start: windowStart,
      used: count,
    };
  }
  s.counters[key.id] = { window_start: windowStart, count: count + 1 };
  // Best-effort flush, don't block the request on disk.
  flush().catch(() => {});
  return {
    allowed: true,
    limit,
    remaining: limit - (count + 1),
    reset_at: resetAt,
    retry_after: 0,
    window_start: windowStart,
    used: count + 1,
  };
}

// Apply standard rate-limit headers to a Response/NextResponse.
export function applyRateHeaders(headers: Headers, d: RateDecision): void {
  headers.set("X-RateLimit-Limit", String(d.limit));
  headers.set("X-RateLimit-Remaining", String(Math.max(0, d.remaining)));
  headers.set("X-RateLimit-Reset", String(d.reset_at));
  headers.set("X-RateLimit-Window", String(WINDOW_SECONDS));
  if (!d.allowed) {
    headers.set("Retry-After", String(d.retry_after));
  }
}
