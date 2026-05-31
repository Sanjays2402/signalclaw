// Per-API-key usage analytics.
//
// Every authenticated request that reaches v1Guard's terminal observe step
// also drops a counter here, bucketed by (key_id, UTC day, route_class,
// status_class). The store is file-backed JSON with atomic rename so it
// survives restarts without pulling in a DB. Counters are bounded: only
// the last RETENTION_DAYS day-buckets per key are kept so the file stays
// O(keys * routes * statuses * 30).
//
// Surfaces:
//   - GET /api/admin/keys/:id/usage             owner-only read of one key
//   - settings/keys page renders a sparkline + last-N-days table per row
//
// This is real wiring: it is the only source of truth for per-key request
// counts and is consulted by the admin UI and by the per-key suspend flow
// for "calls in the last 24h" guidance.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "key-usage.json");
const TMP_FILE = DATA_FILE + ".tmp";

// Keep ~5 weeks of daily buckets per key. Anything older is dropped on write.
export const RETENTION_DAYS = 35;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx";

export type DayBucket = {
  // UTC date, YYYY-MM-DD
  day: string;
  // route_class is the coarse classifier from metricsStore (e.g. "runs",
  // "alerts", "watchlist", "other"). We trust whatever v1Guard passes.
  routes: Record<string, Record<StatusClass, number>>;
};

export type KeyUsage = {
  key_id: string;
  // total successful auth calls observed lifetime (cheap rollup so the UI
  // does not have to re-sum buckets to render a top-line number).
  total: number;
  // last time this key did any v1 request, ISO 8601 UTC. distinct from
  // keyStore.last_used_at because that one only updates on successful
  // authenticate(); usage rows are written even for 4xx/5xx after auth.
  last_request_at: string | null;
  buckets: DayBucket[];
};

type Store = { keys: Record<string, KeyUsage> };

function classifyStatus(status: number): StatusClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function emptyStore(): Store {
  return { keys: {} };
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || !j.keys) return emptyStore();
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return emptyStore();
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TMP_FILE, JSON.stringify(s, null, 2));
  await fs.rename(TMP_FILE, DATA_FILE);
}

function pruneBuckets(buckets: DayBucket[], today: string): DayBucket[] {
  // Keep at most RETENTION_DAYS distinct buckets, dropping the oldest.
  if (buckets.length <= RETENTION_DAYS) return buckets;
  const sorted = [...buckets].sort((a, b) => a.day.localeCompare(b.day));
  return sorted.slice(-RETENTION_DAYS);
}

// Serialise writes so two concurrent observeRequest calls in v1Guard cannot
// clobber each other's increments. Cheap in-process mutex; no DB needed.
let writeChain: Promise<void> = Promise.resolve();

export async function recordRequest(args: {
  key_id: string;
  route_class: string;
  status: number;
  at?: Date;
}): Promise<void> {
  const day = utcDay(args.at);
  const statusClass = classifyStatus(args.status);
  const routeClass = args.route_class || "other";
  const exec = async () => {
    const s = await readStore();
    const entry: KeyUsage =
      s.keys[args.key_id] ||
      ({
        key_id: args.key_id,
        total: 0,
        last_request_at: null,
        buckets: [],
      } as KeyUsage);
    let bucket = entry.buckets.find((b) => b.day === day);
    if (!bucket) {
      bucket = { day, routes: {} };
      entry.buckets.push(bucket);
    }
    const row =
      bucket.routes[routeClass] ||
      ({ "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } as Record<StatusClass, number>);
    row[statusClass] = (row[statusClass] || 0) + 1;
    bucket.routes[routeClass] = row;
    entry.total += 1;
    entry.last_request_at = (args.at ?? new Date()).toISOString();
    entry.buckets = pruneBuckets(entry.buckets, day);
    s.keys[args.key_id] = entry;
    await writeStore(s);
  };
  writeChain = writeChain.then(exec, exec);
  return writeChain;
}

export async function getUsage(key_id: string): Promise<KeyUsage | null> {
  const s = await readStore();
  return s.keys[key_id] ?? null;
}

export async function listUsage(): Promise<KeyUsage[]> {
  const s = await readStore();
  return Object.values(s.keys);
}

// Public, owner-safe summariser used by the settings UI. Returns a
// fixed-shape, fixed-length history so the UI does not have to handle
// sparse days. `days` clamps to [1, RETENTION_DAYS].
export type DailyPoint = {
  day: string;
  total: number;
  success: number;
  client_error: number;
  server_error: number;
};

export type UsageSummary = {
  key_id: string;
  total: number;
  last_request_at: string | null;
  window_days: number;
  window_total: number;
  window_success: number;
  window_client_error: number;
  window_server_error: number;
  daily: DailyPoint[];
  by_route: Array<{
    route_class: string;
    total: number;
    success: number;
    client_error: number;
    server_error: number;
  }>;
};

export function summarise(usage: KeyUsage | null, days: number, now = new Date()): UsageSummary {
  const window = Math.max(1, Math.min(RETENTION_DAYS, Math.floor(days)));
  // Build dense day axis from (today - window + 1) ... today.
  const axis: string[] = [];
  for (let i = window - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    axis.push(d.toISOString().slice(0, 10));
  }
  const empty: UsageSummary = {
    key_id: usage?.key_id ?? "",
    total: usage?.total ?? 0,
    last_request_at: usage?.last_request_at ?? null,
    window_days: window,
    window_total: 0,
    window_success: 0,
    window_client_error: 0,
    window_server_error: 0,
    daily: axis.map((day) => ({
      day,
      total: 0,
      success: 0,
      client_error: 0,
      server_error: 0,
    })),
    by_route: [],
  };
  if (!usage) return empty;
  const bucketByDay = new Map(usage.buckets.map((b) => [b.day, b]));
  const routeAcc = new Map<
    string,
    { total: number; success: number; client_error: number; server_error: number }
  >();
  empty.daily = axis.map((day) => {
    const b = bucketByDay.get(day);
    const point: DailyPoint = {
      day,
      total: 0,
      success: 0,
      client_error: 0,
      server_error: 0,
    };
    if (!b) return point;
    for (const [route, counts] of Object.entries(b.routes)) {
      const s2 = counts["2xx"] || 0;
      const s4 = counts["4xx"] || 0;
      const s5 = counts["5xx"] || 0;
      const s3 = counts["3xx"] || 0;
      const t = s2 + s3 + s4 + s5;
      point.total += t;
      point.success += s2 + s3;
      point.client_error += s4;
      point.server_error += s5;
      const r = routeAcc.get(route) || {
        total: 0,
        success: 0,
        client_error: 0,
        server_error: 0,
      };
      r.total += t;
      r.success += s2 + s3;
      r.client_error += s4;
      r.server_error += s5;
      routeAcc.set(route, r);
    }
    return point;
  });
  for (const p of empty.daily) {
    empty.window_total += p.total;
    empty.window_success += p.success;
    empty.window_client_error += p.client_error;
    empty.window_server_error += p.server_error;
  }
  empty.by_route = [...routeAcc.entries()]
    .map(([route_class, v]) => ({ route_class, ...v }))
    .sort((a, b) => b.total - a.total);
  return empty;
}

// Test seam. Not exported via index.
export async function _resetForTests(): Promise<void> {
  try {
    await fs.unlink(DATA_FILE);
  } catch {}
}
