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
};

let writeQueue: Promise<void> = Promise.resolve();

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
  };
  const line = JSON.stringify(ev) + "\n";
  // Serialize appends so concurrent handlers don't interleave.
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(DATA_FILE, line, "utf8");
    } catch {
      // Audit must never break a real request. Swallow.
    }
  });
  await writeQueue;
  maybeRotate().catch(() => {});
  return ev;
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
}
