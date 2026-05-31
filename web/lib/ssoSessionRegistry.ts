// SSO session registry — server-side ledger for HMAC SSO session cookies.
//
// Problem: the session cookie minted by `ssoSession.ts` is a stateless
// HMAC token. Without a server-side ledger an admin can never:
//   * see which sessions are active right now,
//   * revoke a single laptop without rotating the HMAC key for everyone,
//   * offboard a departed user (kill every session for an email),
//   * trigger a global "force re-auth" after a security incident.
//
// Enterprise procurement always asks "what happens when an employee
// leaves?" — this module is the answer.
//
// Each minted session gets a random `jti`. The registry records
// `{jti, sub, email, iss, iat, exp, ip_hash, user_agent, revoked_at,
// revoked_by, revoked_reason}`. `isRevoked(jti)` is consulted on every
// `verifySessionCookie` call. Two revoke shortcuts exist:
//
//   * `revokeBySession(jti)` — revoke one entry by id.
//   * `revokeByEmail(email)` — mark every active entry for that address
//     as revoked. Used when a user is offboarded from the IdP.
//   * `bumpEpoch()` — increment a global epoch; sessions whose `iat` is
//     older than the epoch boundary are rejected. Used after a security
//     incident to force every device through the IdP again.
//
// Persistence is the same file-backed pattern used by every other store
// in `web/lib`: atomic tmp+rename, in-memory cache, opportunistic
// pruning of expired rows so the file does not grow unbounded.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "sso-sessions.json");

export const MAX_RECORDS = 5000;
export const MAX_REASON_LEN = 280;
export const MAX_UA_LEN = 255;

export type SsoSessionRecord = {
  jti: string;
  sub: string;
  email: string;
  iss: string;
  iat: number;          // unix seconds (issued)
  exp: number;          // unix seconds (cookie expiry)
  ip_hash: string;      // sha256(ip) — we never persist raw IPs
  user_agent: string;
  revoked_at: number | null;     // unix seconds
  revoked_by: string | null;     // actor id (api key id, email, "local")
  revoked_reason: string | null;
};

type Store = {
  records: SsoSessionRecord[];
  // Sessions issued at or before this unix-second epoch are rejected,
  // even if not individually revoked. Used by "force re-auth all".
  global_epoch: number;
};

let cache: Store | null = null;
let writeQueued = false;

async function readStore(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    cache = {
      records: Array.isArray(parsed?.records) ? parsed.records : [],
      global_epoch: Number.isFinite(parsed?.global_epoch) ? Number(parsed.global_epoch) : 0,
    };
  } catch {
    cache = { records: [], global_epoch: 0 };
  }
  return cache;
}

async function flush(): Promise<void> {
  if (writeQueued) return;
  writeQueued = true;
  // Coalesce bursts.
  await new Promise((r) => setImmediate(r));
  writeQueued = false;
  const snapshot = cache ?? { records: [], global_epoch: 0 };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(tmp, DATA_FILE);
}

function nowS(): number { return Math.floor(Date.now() / 1000); }

function prune(store: Store): void {
  const now = nowS();
  // Drop rows whose cookie expired more than 7 days ago AND were either
  // unrevoked or revoked over 7 days ago. We keep recently-revoked rows
  // so an audit reviewer can see "this session was killed yesterday".
  const cutoff = now - 7 * 24 * 60 * 60;
  store.records = store.records.filter((r) => {
    if (r.exp > now) return true;
    if (r.exp > cutoff) return true;
    if (r.revoked_at && r.revoked_at > cutoff) return true;
    return false;
  });
  // Hard cap on total rows so a runaway never blows up disk.
  if (store.records.length > MAX_RECORDS) {
    // Keep newest by iat.
    store.records.sort((a, b) => b.iat - a.iat);
    store.records.length = MAX_RECORDS;
  }
}

function hashIp(ip: string | null | undefined): string {
  const v = (ip || "").trim();
  if (!v) return "";
  return crypto.createHash("sha256").update(v).digest("hex").slice(0, 32);
}

function clamp(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return String(s).slice(0, n);
}

export function newJti(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export type RegisterInput = {
  jti: string;
  sub: string;
  email: string;
  iss: string;
  iat: number;
  exp: number;
  ip?: string | null;
  user_agent?: string | null;
};

export async function registerSession(input: RegisterInput): Promise<SsoSessionRecord> {
  const store = await readStore();
  const rec: SsoSessionRecord = {
    jti: input.jti,
    sub: input.sub,
    email: (input.email || "").toLowerCase(),
    iss: input.iss,
    iat: input.iat,
    exp: input.exp,
    ip_hash: hashIp(input.ip),
    user_agent: clamp(input.user_agent, MAX_UA_LEN),
    revoked_at: null,
    revoked_by: null,
    revoked_reason: null,
  };
  // Replace any existing row with this jti (paranoia; jti is random).
  store.records = store.records.filter((r) => r.jti !== rec.jti);
  store.records.push(rec);
  prune(store);
  await flush();
  return rec;
}

export async function getSession(jti: string): Promise<SsoSessionRecord | null> {
  if (!jti) return null;
  const store = await readStore();
  return store.records.find((r) => r.jti === jti) ?? null;
}

export type RevocationStatus =
  | { revoked: false }
  | { revoked: true; reason: "revoked" | "global-epoch" | "expired" | "unknown-jti" };

// Consulted on every session verification. Returns revoked=true if the
// session must be rejected.
export async function checkSession(jti: string | undefined, iat: number, exp: number): Promise<RevocationStatus> {
  if (!jti) {
    // A jti-less cookie is a legacy/forged token in this model. Reject.
    return { revoked: true, reason: "unknown-jti" };
  }
  const store = await readStore();
  const now = nowS();
  if (exp <= now) return { revoked: true, reason: "expired" };
  if (store.global_epoch && iat <= store.global_epoch) {
    return { revoked: true, reason: "global-epoch" };
  }
  const row = store.records.find((r) => r.jti === jti);
  if (!row) return { revoked: true, reason: "unknown-jti" };
  if (row.revoked_at) return { revoked: true, reason: "revoked" };
  return { revoked: false };
}

export type RevokeInput = {
  actor: string;
  reason?: string | null;
};

export async function revokeBySession(jti: string, opts: RevokeInput): Promise<SsoSessionRecord | null> {
  const store = await readStore();
  const row = store.records.find((r) => r.jti === jti);
  if (!row) return null;
  if (row.revoked_at) return row; // idempotent
  row.revoked_at = nowS();
  row.revoked_by = clamp(opts.actor, 128) || "unknown";
  row.revoked_reason = clamp(opts.reason, MAX_REASON_LEN) || null;
  await flush();
  return row;
}

export async function revokeByEmail(email: string, opts: RevokeInput): Promise<number> {
  const target = (email || "").trim().toLowerCase();
  if (!target) return 0;
  const store = await readStore();
  const now = nowS();
  let n = 0;
  for (const r of store.records) {
    if (r.revoked_at) continue;
    if (r.exp <= now) continue;
    if (r.email !== target) continue;
    r.revoked_at = now;
    r.revoked_by = clamp(opts.actor, 128) || "unknown";
    r.revoked_reason = clamp(opts.reason, MAX_REASON_LEN) || null;
    n++;
  }
  if (n) await flush();
  return n;
}

export async function bumpEpoch(opts: RevokeInput): Promise<{ epoch: number; revoked: number }> {
  const store = await readStore();
  const now = nowS();
  store.global_epoch = now;
  // Also mark every currently-active row revoked so listings show them
  // as killed; this keeps the UI honest after a global force-logout.
  let n = 0;
  for (const r of store.records) {
    if (r.revoked_at) continue;
    if (r.exp <= now) continue;
    r.revoked_at = now;
    r.revoked_by = clamp(opts.actor, 128) || "unknown";
    r.revoked_reason = clamp(opts.reason, MAX_REASON_LEN) || "global-epoch-bump";
    n++;
  }
  await flush();
  return { epoch: now, revoked: n };
}

export type ListOptions = { include_revoked?: boolean; limit?: number };

export async function listSessions(opts: ListOptions = {}): Promise<{
  sessions: SsoSessionRecord[];
  global_epoch: number;
  active_count: number;
}> {
  const store = await readStore();
  const now = nowS();
  const includeRevoked = opts.include_revoked === true;
  const rows = store.records
    .filter((r) => includeRevoked || (!r.revoked_at && r.exp > now))
    .slice()
    .sort((a, b) => b.iat - a.iat);
  const limited = typeof opts.limit === "number" && opts.limit > 0
    ? rows.slice(0, opts.limit)
    : rows;
  const active_count = store.records.filter(
    (r) => !r.revoked_at && r.exp > now,
  ).length;
  return {
    sessions: limited,
    global_epoch: store.global_epoch,
    active_count,
  };
}

// Test helper — never used in production code.
export function _resetForTests(): void {
  cache = null;
}
