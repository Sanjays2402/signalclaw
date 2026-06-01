// File-backed API key store. Real persistence (atomic JSON writes), real
// SHA-256 hashing at rest. Plaintext is shown exactly once at creation time.
//
// Not a multi-tenant auth system. It is, however, real wiring: keys minted
// here unlock the public /v1/* endpoints in this app.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "keys.json");

export type Scope = "read" | "trade" | "admin";

// Coarse-grained RBAC role for an API key. When set, it deterministically
// drives the underlying `scopes` array via roleToScopes(); the two never
// diverge because setKeyRole writes both atomically. Older keys minted
// before roles existed have `role` undefined and continue to be governed
// purely by their `scopes`. Owner and admin both carry the admin scope;
// owner is reserved as a billing/contract anchor for the future.
export type KeyRole = "owner" | "admin" | "member" | "viewer";

export const ALL_ROLES: KeyRole[] = ["owner", "admin", "member", "viewer"];

export function roleToScopes(role: KeyRole): Scope[] {
  switch (role) {
    case "owner":
    case "admin":
      return ["admin", "read", "trade"];
    case "member":
      return ["read", "trade"];
    case "viewer":
      return ["read"];
  }
}

// Best-effort inverse: infer a role label for a key minted before roles
// existed. Used purely for display in publicView; never feeds auth.
export function inferRole(scopes: Scope[]): KeyRole {
  const s = new Set(scopes);
  if (s.has("admin")) return "admin";
  if (s.has("trade")) return "member";
  return "viewer";
}

export type StoredKey = {
  id: string;
  label: string;
  prefix: string; // first 8 chars of the plaintext, e.g. "sc_live_ab"
  hash: string; // sha256(plaintext) hex, never exposed via API
  scopes: Scope[];
  // Coarse RBAC role. Optional for legacy keys; when present, `scopes`
  // is kept in sync with roleToScopes(role) by setKeyRole().
  role?: KeyRole;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
  // Per-key source IP allowlist. Empty/undefined means "any source".
  // Stored as canonical CIDR strings (e.g. "10.0.0.0/8" or "203.0.113.5/32").
  // Enforced in v1Guard before the rate limiter consumes a token.
  ip_allowlist?: string[];
  // Per-key route allowlist (least-privilege path narrowing). Empty or
  // undefined means "any v1 path the scope already permits". A non-empty
  // list additionally requires the request pathname to prefix-match at
  // least one entry; everything else is denied with 403:route_not_allowed.
  // Entries are canonical prefixes under /api/v1/ (see lib/routeAllowlist).
  route_allowlist?: string[];
  // Optional absolute expiry (ISO 8601 UTC). After this instant, the key
  // stops authenticating and is reported as expired. Null/undefined means
  // "never expires" (legacy behaviour). Enforced inside authenticate() so
  // every caller, v1 or admin, sees the same cutoff.
  expires_at?: string | null;
  // Reversible operational hold. Distinct from `revoked` (irreversible).
  // When true, authenticate() refuses the key with reason `key_suspended`
  // on every route. Suspended keys can be re-enabled by an admin without
  // rotating the secret. Used during compromise investigations or while
  // an enterprise customer disputes a charge.
  suspended?: boolean;
  suspended_at?: string | null;
  suspended_reason?: string | null;
};

type Store = { keys: StoredKey[] };

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.keys)) return { keys: [] };
    return j as Store;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { keys: [] };
    throw e;
  }
}

async function writeStore(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function genId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function genSecret(): string {
  // sc_live_<22 url-safe chars>, ~130 bits entropy.
  const raw = crypto.randomBytes(18).toString("base64url");
  return `sc_live_${raw}`;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function publicView(k: StoredKey) {
  const role: KeyRole = (k.role as KeyRole | undefined) ?? inferRole(k.scopes);
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    scopes: k.scopes,
    role,
    effective_scopes: k.scopes,
    created_at: k.created_at,
    last_used_at: k.last_used_at,
    revoked: k.revoked,
    ip_allowlist: Array.isArray(k.ip_allowlist) ? [...k.ip_allowlist] : [],
    route_allowlist: Array.isArray(k.route_allowlist) ? [...k.route_allowlist] : [],
    expires_at: k.expires_at ?? null,
    expired: isExpired(k),
    suspended: !!k.suspended,
    suspended_at: k.suspended_at ?? null,
    suspended_reason: k.suspended_reason ?? null,
  };
}

// Reversible suspend/unsuspend. Returns the updated key, or null if not
// found. Refuses to suspend the env admin id (use SIGNALCLAW_ADMIN_KEY env
// removal instead) or revoked keys (already permanently dead). Reason is
// optional free-form text capped at 200 chars for the audit trail.
// Sets the RBAC role on a key and overwrites the underlying `scopes`
// array with the deterministic role->scopes mapping. Both fields are
// written atomically so the auth path never observes drift between role
// label and effective scopes. Returns the updated key, or null if the
// key does not exist, has been revoked, or is the env admin (which is
// always owner-equivalent and cannot be downgraded via the API).
export async function setKeyRole(
  id: string,
  role: KeyRole,
): Promise<StoredKey | null> {
  if (id === "env-admin") return null;
  if (!ALL_ROLES.includes(role)) {
    throw new Error(`invalid_role: ${role}`);
  }
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  k.role = role;
  k.scopes = roleToScopes(role);
  await writeStore(store);
  return k;
}

// Rename a key without rotating its secret. Labels are trimmed and
// clamped to 80 chars so the inventory always shows a readable name.
// Empty / whitespace-only input raises so a slipped form submission
// cannot blank out an owner name. Refuses the env admin (label is
// hard-coded) and revoked keys.
export async function setKeyLabel(
  id: string,
  label: string,
): Promise<StoredKey | null> {
  if (id === "env-admin") return null;
  if (typeof label !== "string") {
    throw new Error("invalid_label: must be a string");
  }
  const next = label.trim().slice(0, 80);
  if (!next) {
    throw new Error("invalid_label: must not be empty");
  }
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  k.label = next;
  await writeStore(store);
  return k;
}

export async function setKeySuspended(
  id: string,
  suspended: boolean,
  reason?: string | null,
): Promise<StoredKey | null> {
  if (id === "env-admin") return null;
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  if (suspended) {
    k.suspended = true;
    k.suspended_at = new Date().toISOString();
    k.suspended_reason = (reason ?? "").toString().slice(0, 200) || null;
  } else {
    k.suspended = false;
    k.suspended_at = null;
    k.suspended_reason = null;
  }
  await writeStore(store);
  return k;
}

// Pure predicate so route handlers and the UI agree on the cutoff.
export function isExpired(k: { expires_at?: string | null }, now: Date = new Date()): boolean {
  if (!k.expires_at) return false;
  const t = Date.parse(k.expires_at);
  if (!Number.isFinite(t)) return false;
  return t <= now.getTime();
}

// Set or clear a key's absolute expiry. Pass null to clear. Rejects values
// that are not parseable ISO 8601, or that are already in the past (set the
// expiry to a near-future timestamp and let it lapse, or revoke instead).
// Cannot expire a revoked key (no point) or the env admin id.
export async function setKeyExpiry(
  id: string,
  iso: string | null,
): Promise<StoredKey | null> {
  if (id === "env-admin") return null;
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  if (iso === null || iso === "") {
    k.expires_at = null;
  } else {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) {
      throw new Error("invalid_expiry: not a valid ISO 8601 timestamp");
    }
    if (t <= Date.now()) {
      throw new Error("invalid_expiry: expires_at must be in the future");
    }
    k.expires_at = new Date(t).toISOString();
  }
  await writeStore(store);
  return k;
}

// Replaces the IP allowlist on a key. Caller is responsible for validating
// and canonicalizing entries (see lib/ipMatch.canonicalizeCidrList) so this
// stays a pure storage primitive. Returns the updated stored key or null if
// the key does not exist or has been revoked.
export async function setKeyIpAllowlist(
  id: string,
  cidrs: string[],
): Promise<StoredKey | null> {
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  k.ip_allowlist = cidrs.length === 0 ? [] : [...cidrs];
  await writeStore(store);
  return k;
}

// Per-key route allowlist storage primitive. Caller must canonicalize via
// lib/routeAllowlist.canonicalizeRouteList. The env admin id ("env-admin")
// cannot be narrowed here — admins always have full surface access; rotate
// SIGNALCLAW_ADMIN_KEY if you need to restrict them.
export async function setKeyRouteAllowlist(
  id: string,
  routes: string[],
): Promise<StoredKey | null> {
  if (id === "env-admin") return null;
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  k.route_allowlist = routes.length === 0 ? [] : [...routes];
  await writeStore(store);
  return k;
}

export async function getKey(id: string): Promise<StoredKey | null> {
  const store = await readStore();
  return store.keys.find((x) => x.id === id) ?? null;
}

export async function listKeys(): Promise<StoredKey[]> {
  const s = await readStore();
  // Newest first.
  return [...s.keys].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export type CreateInput = { label: string; scopes: Scope[]; expires_at?: string | null };

export async function createKey(
  input: CreateInput,
): Promise<{ key: StoredKey; secret: string }> {
  const label = input.label.trim().slice(0, 80) || "unlabeled";
  // Admin scope can only be granted via env, never via the API, to prevent
  // a freshly-minted "read" key from escalating itself.
  const scopes = Array.from(
    new Set(input.scopes.filter((s) => s === "read" || s === "trade")),
  );
  if (scopes.length === 0) scopes.push("read");

  let expires_at: string | null = null;
  if (input.expires_at) {
    const t = Date.parse(input.expires_at);
    if (!Number.isFinite(t)) {
      throw new Error("invalid_expiry: not a valid ISO 8601 timestamp");
    }
    if (t <= Date.now()) {
      throw new Error("invalid_expiry: expires_at must be in the future");
    }
    expires_at = new Date(t).toISOString();
  }

  const secret = genSecret();
  // Derive an initial role from scopes so a freshly minted key has a
  // stable RBAC label that the admin console and audit trail can name.
  // Admin is never assignable via the public createKey path, so the
  // inferred role is at most "member" (read + trade) or "viewer" (read).
  const initialRole: KeyRole = inferRole(scopes);
  const key: StoredKey = {
    id: genId(),
    label,
    prefix: secret.slice(0, 10),
    hash: sha256(secret),
    scopes,
    role: initialRole,
    created_at: new Date().toISOString(),
    last_used_at: null,
    revoked: false,
    expires_at,
  };
  const store = await readStore();
  store.keys.push(key);
  await writeStore(store);
  return { key, secret };
}

export async function revokeKey(id: string): Promise<boolean> {
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return false;
  if (k.revoked) return true;
  k.revoked = true;
  await writeStore(store);
  return true;
}

// Rotates a key in place: mints a new plaintext secret, replaces the hash
// and prefix, resets last_used_at, and refreshes created_at. The id, label,
// and scopes are preserved so existing references in the UI keep working.
// The old secret stops authenticating immediately. Revoked keys cannot be
// rotated (revive by creating a new key instead).
export async function rotateKey(
  id: string,
): Promise<{ key: StoredKey; secret: string } | null> {
  const store = await readStore();
  const k = store.keys.find((x) => x.id === id);
  if (!k) return null;
  if (k.revoked) return null;
  const secret = genSecret();
  k.prefix = secret.slice(0, 10);
  k.hash = sha256(secret);
  k.last_used_at = null;
  k.created_at = new Date().toISOString();
  await writeStore(store);
  return { key: k, secret };
}

// Used by /v1/* routes: returns the matching, non-revoked key and bumps
// last_used_at. Returns null if nothing matches.
//
// When `opts.req` is supplied, this also enforces per-source-IP failed-auth
// lockout (see authLockoutStore). A locked IP receives a null result without
// any DB lookup; a failed match increments the per-IP failure counter; a
// successful match clears it. Every existing caller routes through this
// function, so the lockout policy is enforced everywhere uniformly without
// touching individual route handlers.
import {
  decideLockout as _decideLockout,
  recordAuthFailure as _recordAuthFailure,
  clearAuthFailures as _clearAuthFailures,
} from "./authLockoutStore.ts";
import { clientIpFromRequest } from "./ipMatch.ts";

export type AuthenticateOptions = {
  req?: Request;
};

export type AuthenticateResult = StoredKey | null;

// Returned to callers that need to distinguish "bad key" (401) from
// "source IP is locked out" (429). The legacy null return shape is
// preserved for the 42 existing call sites; new code can call
// `authenticateWithStatus` to get the structured result.
export type AuthenticateStatus =
  | { kind: "ok"; key: StoredKey }
  | { kind: "unauthorized"; reason: "missing" | "unknown_key" | "key_expired" | "key_suspended" }
  | { kind: "locked"; retry_after_seconds: number; locked_until: string };

export async function authenticateWithStatus(
  secret: string,
  opts: AuthenticateOptions = {},
): Promise<AuthenticateStatus> {
  const req = opts.req;
  const ip = req ? clientIpFromRequest(req) : null;
  if (ip) {
    const decision = await _decideLockout(ip);
    if (decision.locked) {
      return { kind: "locked", retry_after_seconds: decision.retry_after_seconds, locked_until: decision.locked_until };
    }
  }
  if (!secret) {
    // No credentials presented: not counted as a brute-force attempt,
    // otherwise unauthenticated public probes (CORS preflights, browsers)
    // would trip the lockout immediately. Only *wrong* credentials count.
    return { kind: "unauthorized", reason: "missing" };
  }
  const adminEnv = process.env.SIGNALCLAW_ADMIN_KEY;
  if (adminEnv && timingSafeEqual(secret, adminEnv)) {
    if (ip) await _clearAuthFailures(ip).catch(() => {});
    return {
      kind: "ok",
      key: {
        id: "env-admin",
        label: "env admin",
        prefix: adminEnv.slice(0, 10),
        hash: sha256(adminEnv),
        scopes: ["admin", "read", "trade"],
        role: "owner",
        created_at: "1970-01-01T00:00:00.000Z",
        last_used_at: new Date().toISOString(),
        revoked: false,
      },
    };
  }
  const h = sha256(secret);
  const store = await readStore();
  const k = store.keys.find((x) => x.hash === h && !x.revoked);
  if (!k) {
    if (ip) await _recordAuthFailure(ip).catch(() => {});
    return { kind: "unauthorized", reason: "unknown_key" };
  }
  if (isExpired(k)) {
    // A known-good key that has aged out is *not* a brute-force signal;
    // do not increment the IP counter. Just refuse.
    return { kind: "unauthorized", reason: "key_expired" };
  }
  if (k.suspended) {
    return { kind: "unauthorized", reason: "key_suspended" };
  }
  k.last_used_at = new Date().toISOString();
  await writeStore(store).catch(() => {});
  if (ip) await _clearAuthFailures(ip).catch(() => {});
  return { kind: "ok", key: k };
}

export async function authenticate(
  secret: string,
  opts: AuthenticateOptions = {},
): Promise<AuthenticateResult> {
  const r = await authenticateWithStatus(secret, opts);
  return r.kind === "ok" ? r.key : null;
}


function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Extracts a bearer token from a Request, accepting either:
//   Authorization: Bearer sc_live_...
//   x-api-key: sc_live_...
export function extractKey(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^bearer\s+(\S+)/i);
  if (m) return m[1];
  return req.headers.get("x-api-key") || "";
}
