// File-backed idempotency store for v1 mutating endpoints.
//
// Enterprise HTTP clients (Stripe, Square, GitHub, etc.) expect that a
// mutating request can be safely retried by sending the same `Idempotency-Key`
// header. The first call performs the work and caches its response; later
// calls with the same key and matching request fingerprint return the cached
// response (with `Idempotent-Replayed: true`) instead of mutating state again.
//
// Behaviour matches the de facto Stripe contract:
//
//   * Header name: `Idempotency-Key`. Optional. Skipped when absent.
//   * Scope: keyed by (api-key id, header value). Two API keys may reuse the
//     same header value safely; one API key may not reuse the same value with
//     a different request body or path.
//   * Conflict: same (key, header) with a different request fingerprint
//     returns 409 idempotency_conflict (no work executed).
//   * Replay: same (key, header) with the same fingerprint returns the
//     original cached status + body + a small set of safe response headers.
//   * TTL: 24h sliding window. Records are also evicted opportunistically
//     when the store grows past MAX_RECORDS.
//   * Only 2xx responses are cached. 4xx/5xx pass through so the client can
//     fix the request and retry.
//
// Persistence is the same file-backed pattern used by the other stores in
// this app: atomic writes via tmp + rename, an in-memory cache to avoid disk
// thrash, and best-effort flushing.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "idempotency.json");

export const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const MAX_RECORDS = 2000;
export const MAX_HEADER_LEN = 255;
// Allowed: printable ASCII without whitespace or control chars. Same shape
// other vendors enforce so callers can reuse their existing helpers.
const HEADER_RE = /^[A-Za-z0-9._:\-\/+=]{1,255}$/;

export type IdempotencyRecord = {
  key_id: string; // owning api-key id
  header: string; // raw Idempotency-Key value
  fingerprint: string; // sha256 of (method|route|body)
  status: number;
  body: string; // serialised response body
  content_type: string;
  cached_headers: Record<string, string>;
  created_at: string; // ISO timestamp
  expires_at: string; // ISO timestamp
};

type Store = { records: IdempotencyRecord[] };

let cache: Store | null = null;
let writeQueued = false;

async function readStore(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    cache = { records: Array.isArray(j?.records) ? j.records : [] };
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    cache = { records: [] };
  }
  return cache;
}

async function writeStore(s: Store): Promise<void> {
  cache = s;
  if (writeQueued) return;
  writeQueued = true;
  queueMicrotask(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
      await fs.rename(tmp, DATA_FILE);
    } catch {
      // best-effort; next successful write will recover
    } finally {
      writeQueued = false;
    }
  });
}

function gc(records: IdempotencyRecord[], now: number): IdempotencyRecord[] {
  const live = records.filter((r) => Date.parse(r.expires_at) > now);
  if (live.length <= MAX_RECORDS) return live;
  // Drop oldest by created_at when we blow the cap.
  return live
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(live.length - MAX_RECORDS);
}

export function validateHeader(v: string | null): { ok: true; value: string } | { ok: false; code: string; message: string } {
  if (v === null || v === undefined) return { ok: false, code: "missing", message: "no Idempotency-Key header" };
  const s = v.trim();
  if (s.length === 0) return { ok: false, code: "empty", message: "Idempotency-Key header is empty" };
  if (s.length > MAX_HEADER_LEN) return { ok: false, code: "too_long", message: `Idempotency-Key must be at most ${MAX_HEADER_LEN} chars` };
  if (!HEADER_RE.test(s)) return { ok: false, code: "bad_chars", message: "Idempotency-Key may contain only [A-Za-z0-9._:\\-/+=]" };
  return { ok: true, value: s };
}

export function fingerprint(method: string, route: string, body: string): string {
  return crypto.createHash("sha256").update(`${method.toUpperCase()}\n${route}\n${body}`).digest("hex");
}

export type LookupResult =
  | { kind: "miss" }
  | { kind: "hit"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord };

export async function lookup(
  keyId: string,
  header: string,
  fp: string,
  now: Date = new Date(),
): Promise<LookupResult> {
  const s = await readStore();
  const nowMs = now.getTime();
  const live = gc(s.records, nowMs);
  if (live.length !== s.records.length) {
    await writeStore({ records: live });
  }
  const hit = live.find((r) => r.key_id === keyId && r.header === header);
  if (!hit) return { kind: "miss" };
  if (hit.fingerprint !== fp) return { kind: "conflict", record: hit };
  return { kind: "hit", record: hit };
}

export async function store(rec: IdempotencyRecord): Promise<void> {
  const s = await readStore();
  const nowMs = Date.now();
  const live = gc(s.records, nowMs).filter(
    (r) => !(r.key_id === rec.key_id && r.header === rec.header),
  );
  live.push(rec);
  await writeStore({ records: live });
}

export async function listForKey(keyId: string, limit = 50): Promise<IdempotencyRecord[]> {
  const s = await readStore();
  const live = gc(s.records, Date.now()).filter((r) => r.key_id === keyId);
  return live
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
}

export async function listAll(limit = 200): Promise<IdempotencyRecord[]> {
  const s = await readStore();
  const live = gc(s.records, Date.now());
  return live
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
}

// Test-only: reset the in-memory cache so unit tests can swap files.
export function _resetCache(): void {
  cache = null;
}
