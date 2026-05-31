// Append-only audit log for authenticated API key activity.
//
// Every call into a /api/v1/* endpoint (and the admin key-management surface)
// runs through `recordAuditEvent`. We persist the key id + label + scopes,
// the route, method, status, a SHA-256 hash of the caller IP (never the raw
// IP), and an optional small JSON details blob. Plaintext secrets and request
// bodies are NEVER persisted — only the route, status, and a short reason.
//
// Storage is a single JSONL file at `<cwd>/.data/audit.jsonl`. Writes go
// through a serialized append queue so concurrent route handlers don't
// interleave half-lines. A soft cap (default 50k entries) rotates the oldest
// half off into `audit.jsonl.1` to keep reads fast.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maybeAutoSweep } from "./retentionStore.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "audit.jsonl");
const ROLL_FILE = path.join(DATA_DIR, "audit.jsonl.1");
// Persistent per-installation HMAC key for the audit hash chain. Generated
// on first write and never rotated; rotating would invalidate prior links.
// The key file is mode 0600 so a casual reader of .data cannot forge a
// chain that re-hashes to match. Real deployments should mount this on an
// encrypted volume. SOC2 reviewers ask for tamper-evidence on audit logs;
// the chain below is the answer.
const CHAIN_KEY_FILE = path.join(DATA_DIR, "audit.chainkey");
const GENESIS_PREV = "0".repeat(64);

const MAX_LINES = 50_000;
const ROLL_TO = 25_000;
const MAX_DETAIL_BYTES = 2048;

export type AuditEvent = {
  id: string;
  ts: string; // ISO 8601
  key_id: string; // "anon" if no key was presented
  key_label: string;
  key_prefix: string;
  scopes: string[];
  route: string; // pathname only, no query
  method: string;
  status: number;
  ok: boolean; // status < 400
  ip_hash: string | null; // sha256 of raw IP, salted with key id
  user_agent: string | null;
  reason: string | null; // e.g. "forbidden:trade-required"
  details: Record<string, unknown> | null;
  request_id: string | null; // X-Request-Id propagated from the edge
  // Tamper-evidence: HMAC-SHA256 over (prev_hash || canonical(event_minus_hash)).
  // Older events written before this feature shipped have empty strings here;
  // verifyChain() treats them as a pre-chain prefix and starts checking from
  // the first event that has both fields populated.
  prev_hash: string;
  hash: string;
};

let writeQueue: Promise<void> = Promise.resolve();
let chainKeyCache: Buffer | null = null;
let lastChainHashCache: string | null = null;

async function getChainKey(): Promise<Buffer> {
  if (chainKeyCache) return chainKeyCache;
  try {
    const raw = await fs.readFile(CHAIN_KEY_FILE);
    if (raw.length >= 32) {
      chainKeyCache = raw;
      return chainKeyCache;
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  const tmp = CHAIN_KEY_FILE + ".tmp";
  await fs.writeFile(tmp, key, { mode: 0o600 });
  await fs.rename(tmp, CHAIN_KEY_FILE);
  try { await fs.chmod(CHAIN_KEY_FILE, 0o600); } catch {}
  chainKeyCache = key;
  return key;
}

// Canonical JSON of an event for hashing: stable key order, hash fields excluded.
function canonicalForHash(ev: AuditEvent): string {
  const { hash: _h, prev_hash: _p, ...rest } = ev;
  const keys = Object.keys(rest).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = (rest as Record<string, unknown>)[k];
  return JSON.stringify(ordered);
}

async function computeHash(ev: AuditEvent, prev: string): Promise<string> {
  const key = await getChainKey();
  const h = crypto.createHmac("sha256", key);
  h.update(prev);
  h.update("|");
  h.update(canonicalForHash(ev));
  return h.digest("hex");
}

async function lastChainedHash(): Promise<string> {
  if (lastChainHashCache) return lastChainHashCache;
  let primary = "";
  try {
    primary = await fs.readFile(DATA_FILE, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const lines = primary.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as AuditEvent;
      if (typeof obj.hash === "string" && obj.hash.length === 64) {
        lastChainHashCache = obj.hash;
        return obj.hash;
      }
    } catch {}
  }
  return GENESIS_PREV;
}

// Exposed for tests; clears in-memory caches after a clearAudit().
export function _resetChainCache(): void {
  lastChainHashCache = null;
  chainKeyCache = null;
}

function genId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function hashIp(ip: string | null, keyId: string): string | null {
  if (!ip) return null;
  // Per-key salt so the same IP doesn't produce a stable id across keys.
  return sha256(`${keyId}:${ip}`).slice(0, 32);
}

function safeDetails(d: unknown): Record<string, unknown> | null {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  try {
    const s = JSON.stringify(d);
    if (s.length > MAX_DETAIL_BYTES) {
      return { _truncated: true, bytes: s.length };
    }
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim() || null;
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim() || null;
  return null;
}

async function maybeRotate(): Promise<void> {
  try {
    const stat = await fs.stat(DATA_FILE);
    // ~250 bytes per line is a fine upper bound; tail-count via read.
    if (stat.size < MAX_LINES * 220) return;
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(lines.length - ROLL_TO);
    const rolled = lines.slice(0, lines.length - ROLL_TO);
    await fs.writeFile(ROLL_FILE, rolled.join("\n") + "\n", "utf8");
    const tmp = DATA_FILE + ".tmp";
    await fs.writeFile(tmp, keep.join("\n") + "\n", "utf8");
    await fs.rename(tmp, DATA_FILE);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      // Rotation is best-effort. Never block writes.
    }
  }
}

export type RecordInput = {
  req?: Request;
  route: string;
  method: string;
  status: number;
  key?: {
    id: string;
    label: string;
    prefix: string;
    scopes: string[];
  } | null;
  reason?: string | null;
  details?: unknown;
};

export async function recordAuditEvent(input: RecordInput): Promise<AuditEvent> {
  const key = input.key ?? null;
  const ev: AuditEvent = {
    id: genId(),
    ts: new Date().toISOString(),
    key_id: key?.id ?? "anon",
    key_label: key?.label ?? "",
    key_prefix: key?.prefix ?? "",
    scopes: key?.scopes ?? [],
    route: input.route,
    method: input.method.toUpperCase(),
    status: input.status,
    ok: input.status < 400,
    ip_hash: hashIp(input.req ? clientIp(input.req) : null, key?.id ?? "anon"),
    user_agent: input.req?.headers.get("user-agent")?.slice(0, 200) ?? null,
    reason: input.reason ?? null,
    details: safeDetails(input.details),
    request_id:
      (input.req?.headers.get("x-request-id") || "").slice(0, 128) || null,
    prev_hash: "",
    hash: "",
  };
  // Serialize appends so concurrent handlers don't interleave AND so the
  // chain stays linear: each event's prev_hash = previous event's hash.
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const prev = await lastChainedHash();
      ev.prev_hash = prev;
      ev.hash = await computeHash(ev, prev);
      lastChainHashCache = ev.hash;
      await fs.appendFile(DATA_FILE, JSON.stringify(ev) + "\n", "utf8");
    } catch {
      // Audit must never break a real request. Swallow.
    }
  });
  await writeQueue;
  maybeRotate().catch(() => {});
  return ev;
}

export type ChainVerifyResult = {
  ok: boolean;
  checked: number;
  skipped_legacy: number;
  first_chained_index: number | null;
  last_hash: string | null;
  break_at_index: number | null;
  break_event_id: string | null;
  reason: string | null;
};

// Walks the on-disk log (rolled + primary, in original write order) and
// re-derives the HMAC chain. Returns ok=false at the first event whose
// stored hash does not match HMAC(prev_hash || canonical(event)). Events
// written before this feature (no hash field) are reported as
// skipped_legacy and do not fail verification.
export async function verifyChain(): Promise<ChainVerifyResult> {
  const events = await readAllLines();
  const res: ChainVerifyResult = {
    ok: true,
    checked: 0,
    skipped_legacy: 0,
    first_chained_index: null,
    last_hash: null,
    break_at_index: null,
    break_event_id: null,
    reason: null,
  };
  let prev = GENESIS_PREV;
  let started = false;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const hasChain =
      typeof ev.hash === "string" && ev.hash.length === 64 &&
      typeof ev.prev_hash === "string" && ev.prev_hash.length === 64;
    if (!hasChain) {
      if (!started) {
        res.skipped_legacy++;
        continue;
      }
      res.ok = false;
      res.break_at_index = i;
      res.break_event_id = ev.id ?? null;
      res.reason = "missing_hash_after_chain_started";
      return res;
    }
    if (!started) {
      started = true;
      res.first_chained_index = i;
      prev = ev.prev_hash; // accept first link's anchor as ground truth
    }
    if (ev.prev_hash !== prev) {
      res.ok = false;
      res.break_at_index = i;
      res.break_event_id = ev.id;
      res.reason = "prev_hash_mismatch";
      return res;
    }
    const expected = await computeHash(ev, prev);
    if (expected !== ev.hash) {
      res.ok = false;
      res.break_at_index = i;
      res.break_event_id = ev.id;
      res.reason = "hash_mismatch";
      return res;
    }
    prev = ev.hash;
    res.checked++;
    res.last_hash = ev.hash;
  }
  return res;
}

export type QueryInput = {
  key_id?: string;
  method?: string;
  route?: string; // substring match
  ok?: boolean;
  since?: string; // ISO 8601
  limit?: number;
  offset?: number;
};

async function readAllLines(): Promise<AuditEvent[]> {
  let primary = "";
  let rolled = "";
  try {
    primary = await fs.readFile(DATA_FILE, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  try {
    rolled = await fs.readFile(ROLL_FILE, "utf8");
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const raw = (rolled + primary).split("\n").filter(Boolean);
  const out: AuditEvent[] = [];
  for (const line of raw) {
    try {
      out.push(JSON.parse(line) as AuditEvent);
    } catch {
      // skip corrupted lines
    }
  }
  return out;
}

export async function queryAudit(
  input: QueryInput = {},
): Promise<{ events: AuditEvent[]; total: number; limit: number; offset: number }> {
  try {
    await maybeAutoSweep();
  } catch {}
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);
  const all = await readAllLines();
  let filtered = all;
  if (input.key_id) filtered = filtered.filter((e) => e.key_id === input.key_id);
  if (input.method) {
    const m = input.method.toUpperCase();
    filtered = filtered.filter((e) => e.method === m);
  }
  if (input.route) {
    const r = input.route;
    filtered = filtered.filter((e) => e.route.includes(r));
  }
  if (typeof input.ok === "boolean") {
    filtered = filtered.filter((e) => e.ok === input.ok);
  }
  if (input.since) {
    const t = input.since;
    filtered = filtered.filter((e) => e.ts >= t);
  }
  // Newest first.
  filtered.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const slice = filtered.slice(offset, offset + limit);
  return { events: slice, total: filtered.length, limit, offset };
}

export async function clearAudit(): Promise<void> {
  // Test-only helper; not exposed via any route.
  try {
    await fs.unlink(DATA_FILE);
  } catch {}
  try {
    await fs.unlink(ROLL_FILE);
  } catch {}
  try {
    await fs.unlink(CHAIN_KEY_FILE);
  } catch {}
  _resetChainCache();
}
