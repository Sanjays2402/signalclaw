// Break-glass emergency access.
//
// Procurement reality: enterprise IT teams require a documented,
// time-boxed, auditable way for a workspace owner to bypass the
// workspace IP allowlist during an incident (e.g. they need to reach
// the admin console from an unscheduled location to revoke a leaked
// API key). The bypass MUST be:
//
//   - explicitly granted by an admin (not implicit),
//   - time-boxed (default 30 min, hard cap 60 min),
//   - require a non-empty justification stored on the grant,
//   - audited on grant, on every use, and on revoke,
//   - revocable in one click,
//   - automatically expire (no human action required),
//   - never bypass admin MFA, never bypass per-key scopes,
//     ONLY bypass the workspace-level IP allowlist
//     (the one thing that can lock an admin out from the road).
//
// Storage: <DATA_DIR>/breakglass.json. Single active grant at a time;
// granting a new one supersedes (and audits) the prior one. Concurrent
// writes serialized through a tiny in-process queue.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "breakglass.json");

// 60 minutes max — short enough that a leaked grant has tight blast
// radius, long enough that an admin can resolve a real incident.
export const MAX_TTL_SECONDS = 60 * 60;
export const DEFAULT_TTL_SECONDS = 30 * 60;
export const MIN_REASON_LEN = 10;
export const MAX_REASON_LEN = 500;

export type BreakGlassGrant = {
  id: string;
  granted_at: string;
  expires_at: string;
  granted_by: string | null;
  reason: string;
  ttl_seconds: number;
  uses: number;
  last_used_at: string | null;
  // Set when an admin manually revokes; once set the grant is dead
  // regardless of expires_at.
  revoked_at: string | null;
  revoked_by: string | null;
};

export type BreakGlassState = {
  active: BreakGlassGrant | null;
  // Append-only history of recent grants (most recent first). Bounded
  // so the file stays small; full long-term history lives in the
  // tamper-evident audit chain.
  history: BreakGlassGrant[];
};

const MAX_HISTORY = 50;

const EMPTY: BreakGlassState = { active: null, history: [] };

let writeQueue: Promise<void> = Promise.resolve();

function cloneGrant(g: BreakGlassGrant): BreakGlassGrant {
  return { ...g };
}

function cloneState(s: BreakGlassState): BreakGlassState {
  return {
    active: s.active ? cloneGrant(s.active) : null,
    history: s.history.map(cloneGrant),
  };
}

async function readState(): Promise<BreakGlassState> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return cloneState(EMPTY);
    const active = parseGrant(j.active);
    const history = Array.isArray(j.history)
      ? j.history.map(parseGrant).filter((g: BreakGlassGrant | null): g is BreakGlassGrant => !!g)
      : [];
    return { active, history };
  } catch (e: any) {
    if (e?.code === "ENOENT") return cloneState(EMPTY);
    throw e;
  }
}

function parseGrant(j: any): BreakGlassGrant | null {
  if (!j || typeof j !== "object") return null;
  if (typeof j.id !== "string" || typeof j.granted_at !== "string") return null;
  if (typeof j.expires_at !== "string" || typeof j.reason !== "string") return null;
  return {
    id: j.id,
    granted_at: j.granted_at,
    expires_at: j.expires_at,
    granted_by: typeof j.granted_by === "string" ? j.granted_by : null,
    reason: j.reason,
    ttl_seconds: Number.isFinite(j.ttl_seconds) ? Number(j.ttl_seconds) : 0,
    uses: Number.isFinite(j.uses) ? Number(j.uses) : 0,
    last_used_at: typeof j.last_used_at === "string" ? j.last_used_at : null,
    revoked_at: typeof j.revoked_at === "string" ? j.revoked_at : null,
    revoked_by: typeof j.revoked_by === "string" ? j.revoked_by : null,
  };
}

async function writeState(s: BreakGlassState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

export type GrantInput = {
  reason: string;
  ttl_seconds?: number;
  actor?: string | null;
  now?: Date;
};

export type GrantResult =
  | { ok: true; grant: BreakGlassGrant; superseded: BreakGlassGrant | null }
  | { ok: false; code: "bad_reason" | "bad_ttl"; message: string };

export async function grant(input: GrantInput): Promise<GrantResult> {
  const reason = (input.reason || "").trim();
  if (reason.length < MIN_REASON_LEN) {
    return {
      ok: false,
      code: "bad_reason",
      message: `reason must be at least ${MIN_REASON_LEN} characters`,
    };
  }
  if (reason.length > MAX_REASON_LEN) {
    return {
      ok: false,
      code: "bad_reason",
      message: `reason must be at most ${MAX_REASON_LEN} characters`,
    };
  }
  const ttl = Math.floor(
    Number.isFinite(input.ttl_seconds) ? Number(input.ttl_seconds) : DEFAULT_TTL_SECONDS,
  );
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) {
    return {
      ok: false,
      code: "bad_ttl",
      message: `ttl_seconds must be between 60 and ${MAX_TTL_SECONDS}`,
    };
  }

  const out: { grant?: BreakGlassGrant; superseded?: BreakGlassGrant | null } = {};
  writeQueue = writeQueue.then(async () => {
    const state = await readState();
    const now = input.now ?? new Date();
    const superseded = state.active && !isExpired(state.active, now) ? state.active : null;
    if (superseded) {
      // Force-revoke the prior grant as part of supersede so /history
      // makes sense to a reviewer.
      superseded.revoked_at = now.toISOString();
      superseded.revoked_by = input.actor ?? null;
    }
    const g: BreakGlassGrant = {
      id: crypto.randomUUID(),
      granted_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
      granted_by: input.actor ?? null,
      reason,
      ttl_seconds: ttl,
      uses: 0,
      last_used_at: null,
      revoked_at: null,
      revoked_by: null,
    };
    const history = [
      ...(superseded ? [superseded] : []),
      ...(state.active && state.active !== superseded ? [state.active] : []),
      ...state.history,
    ].slice(0, MAX_HISTORY);
    await writeState({ active: g, history });
    out.grant = g;
    out.superseded = superseded;
  });
  await writeQueue;
  return { ok: true, grant: out.grant!, superseded: out.superseded ?? null };
}

export type RevokeResult =
  | { ok: true; revoked: BreakGlassGrant }
  | { ok: false; code: "no_active"; message: string };

export async function revoke(actor: string | null, now?: Date): Promise<RevokeResult> {
  const out: { result?: RevokeResult } = {};
  writeQueue = writeQueue.then(async () => {
    const state = await readState();
    const t = now ?? new Date();
    if (!state.active || isExpired(state.active, t)) {
      out.result = { ok: false, code: "no_active", message: "no active break-glass grant" };
      return;
    }
    const g = cloneGrant(state.active);
    g.revoked_at = t.toISOString();
    g.revoked_by = actor;
    const history = [g, ...state.history].slice(0, MAX_HISTORY);
    await writeState({ active: null, history });
    out.result = { ok: true, revoked: g };
  });
  await writeQueue;
  return out.result!;
}

export function isExpired(g: BreakGlassGrant, now: Date = new Date()): boolean {
  if (g.revoked_at) return true;
  const exp = Date.parse(g.expires_at);
  if (!Number.isFinite(exp)) return true;
  return exp <= now.getTime();
}

export async function getState(): Promise<BreakGlassState> {
  return readState();
}

// Returns the active grant if and only if it is currently valid
// (not revoked, not past expiry). Pure read, does NOT increment uses.
export async function getActive(now: Date = new Date()): Promise<BreakGlassGrant | null> {
  const s = await readState();
  if (!s.active) return null;
  if (isExpired(s.active, now)) return null;
  return cloneGrant(s.active);
}

// Records a successful use of the active grant. Persists uses + last_used_at.
// Fire-and-forget from the caller's perspective: never throws.
export async function recordUse(now: Date = new Date()): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    try {
      const s = await readState();
      if (!s.active || isExpired(s.active, now)) return;
      const g = cloneGrant(s.active);
      g.uses += 1;
      g.last_used_at = now.toISOString();
      await writeState({ active: g, history: s.history });
    } catch {
      /* swallow */
    }
  });
  await writeQueue;
}

export function describeRemaining(g: BreakGlassGrant, now: Date = new Date()): {
  expired: boolean;
  seconds_remaining: number;
} {
  if (isExpired(g, now)) return { expired: true, seconds_remaining: 0 };
  const ms = Date.parse(g.expires_at) - now.getTime();
  return { expired: false, seconds_remaining: Math.max(0, Math.floor(ms / 1000)) };
}
