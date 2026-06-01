// Session idle + absolute timeout policy.
//
// Procurement reality: SOC2 CC6.1 and every enterprise security
// questionnaire ("does your product enforce a session idle timeout?")
// expect that an SSO browser session is killed after N minutes of
// inactivity, AND that even an active session is forced through
// re-auth at some absolute upper bound (typically 8-24h). The SSO
// session cookie ships with a fixed `exp` (absolute) but until this
// module landed there was no idle gate and no admin lever to tighten
// the absolute upper bound below the cookie's own TTL.
//
// This module:
//   * persists `{ idle_timeout_s, absolute_timeout_s, enforce,
//     updated_at, updated_by }` at <DATA_DIR>/session-timeout.json,
//   * is consulted by `ssoSessionRegistry.checkSession` on every
//     authenticated request, so the gate runs in the hot path,
//   * exposes a tiny pure helper `decideTimeout` for unit tests so the
//     "is this session past its idle limit?" logic stays I/O free.
//
// Defaults are off (enforce=false) so an upgrade does not log out an
// existing tenant; an admin opts in from /admin/sessions. When opted
// in, an idle-expired session is rejected the same way a revoked one
// is, and the registry row is marked revoked so the auditor can see
// WHY ("idle-timeout" / "absolute-timeout").

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "session-timeout.json");

// Bounds. 60s lower bound keeps a misconfiguration from logging
// everyone out mid-click; 30d upper bound matches the registry cap.
export const MIN_IDLE_S = 60;
export const MAX_IDLE_S = 30 * 24 * 60 * 60;
export const MIN_ABSOLUTE_S = 5 * 60;
export const MAX_ABSOLUTE_S = 30 * 24 * 60 * 60;

export type SessionTimeoutPolicy = {
  enforce: boolean;
  idle_timeout_s: number;     // 0 = no idle gate
  absolute_timeout_s: number; // 0 = use cookie's own exp
  updated_at: string | null;
  updated_by: string | null;
};

export function defaultPolicy(): SessionTimeoutPolicy {
  return {
    enforce: false,
    idle_timeout_s: 30 * 60,        // 30 minutes idle
    absolute_timeout_s: 12 * 60 * 60, // 12 hours absolute
    updated_at: null,
    updated_by: null,
  };
}

let cache: SessionTimeoutPolicy | null = null;

export async function getPolicy(): Promise<SessionTimeoutPolicy> {
  if (cache) return { ...cache };
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionTimeoutPolicy>;
    cache = { ...defaultPolicy(), ...parsed };
  } catch {
    cache = defaultPolicy();
  }
  return { ...cache };
}

export type UpdateInput = {
  enforce?: boolean;
  idle_timeout_s?: number;
  absolute_timeout_s?: number;
  actor: string;
};

export type UpdateResult =
  | { ok: true; policy: SessionTimeoutPolicy }
  | { ok: false; code: "invalid_idle" | "invalid_absolute"; message: string };

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}

export async function updatePolicy(input: UpdateInput): Promise<UpdateResult> {
  const cur = await getPolicy();
  const next: SessionTimeoutPolicy = { ...cur };

  if (typeof input.enforce === "boolean") next.enforce = input.enforce;

  if (input.idle_timeout_s !== undefined) {
    if (!isInt(input.idle_timeout_s) || input.idle_timeout_s < 0) {
      return { ok: false, code: "invalid_idle", message: "idle_timeout_s must be a non-negative integer" };
    }
    if (input.idle_timeout_s !== 0 && (input.idle_timeout_s < MIN_IDLE_S || input.idle_timeout_s > MAX_IDLE_S)) {
      return { ok: false, code: "invalid_idle", message: `idle_timeout_s must be 0 or between ${MIN_IDLE_S} and ${MAX_IDLE_S}` };
    }
    next.idle_timeout_s = input.idle_timeout_s;
  }

  if (input.absolute_timeout_s !== undefined) {
    if (!isInt(input.absolute_timeout_s) || input.absolute_timeout_s < 0) {
      return { ok: false, code: "invalid_absolute", message: "absolute_timeout_s must be a non-negative integer" };
    }
    if (input.absolute_timeout_s !== 0 && (input.absolute_timeout_s < MIN_ABSOLUTE_S || input.absolute_timeout_s > MAX_ABSOLUTE_S)) {
      return { ok: false, code: "invalid_absolute", message: `absolute_timeout_s must be 0 or between ${MIN_ABSOLUTE_S} and ${MAX_ABSOLUTE_S}` };
    }
    next.absolute_timeout_s = input.absolute_timeout_s;
  }

  next.updated_at = new Date().toISOString();
  next.updated_by = input.actor.slice(0, 128) || "unknown";

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${POLICY_FILE}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(tmp, POLICY_FILE);
  cache = next;
  return { ok: true, policy: { ...next } };
}

// Pure helper: given a policy + the session timestamps, decide if it
// must be rejected. Returns `null` when the session is fine, or a
// reason string when it must be killed. Kept side-effect free so the
// registry can call it on the hot path and tests can exercise it
// without touching disk.
export type TimeoutDecision = null | {
  reason: "idle-timeout" | "absolute-timeout";
};

export function decideTimeout(
  policy: SessionTimeoutPolicy,
  args: { iat: number; last_seen_at: number | null; now: number },
): TimeoutDecision {
  if (!policy.enforce) return null;
  const { iat, last_seen_at, now } = args;

  if (policy.absolute_timeout_s > 0 && now - iat >= policy.absolute_timeout_s) {
    return { reason: "absolute-timeout" };
  }
  if (policy.idle_timeout_s > 0) {
    // last_seen_at being null means we have not observed any traffic
    // since the cookie was minted; fall back to issued-at so a stale
    // never-used cookie is also rejected past the idle window.
    const reference = last_seen_at ?? iat;
    if (now - reference >= policy.idle_timeout_s) {
      return { reason: "idle-timeout" };
    }
  }
  return null;
}

export function _resetForTests(): void {
  cache = null;
}
