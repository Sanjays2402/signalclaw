// Per-source-IP failed-authentication lockout.
//
// Procurement reality: enterprise security teams want a documented brute-force
// defense on every authenticated surface. Rate limits protect against volume,
// but a credential-stuffing attempt that pauses between guesses can still
// burn through millions of keys without ever tripping a per-key bucket
// (because the attacker doesn't have a key yet). This module tracks failed
// authentication attempts per client IP and locks the source out for a
// configurable cooldown after a configurable threshold.
//
// Persisted at <DATA_DIR>/auth-lockout.json so a process restart does not
// hand attackers a clean slate. Writes are queued through a single promise
// chain to avoid interleaved file corruption (same pattern auditStore uses).
//
// Enforcement point: inside `authenticate()` in keyStore. Every existing
// caller (admin routes + v1 routes) routes through that single function, so
// hooking it there guarantees coverage without sweeping 40+ route files for
// half-applied middleware.
//
// IPv6 considered: clientIpFromRequest() returns the normalized form; we key
// the lockout map on that same string, so v4 and v6 callers cannot bypass
// each other.

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "auth-lockout.json");
const CONFIG_FILE = path.join(DATA_DIR, "auth-lockout-config.json");

export type LockoutConfig = {
  // Number of consecutive failed auth attempts from one IP that trips a lockout.
  threshold: number;
  // Sliding window in seconds. Failures older than this are forgotten.
  window_seconds: number;
  // Cooldown in seconds. After threshold is hit, all auth from that IP is
  // rejected for this many seconds.
  cooldown_seconds: number;
  // Master switch. Off by default so existing deployments are unaffected
  // until an admin opts in.
  enabled: boolean;
};

export const DEFAULT_CONFIG: LockoutConfig = {
  threshold: 10,
  window_seconds: 300,
  cooldown_seconds: 900,
  enabled: false,
};

const MAX_TRACKED_IPS = 10_000;

export type IpState = {
  // Unix-epoch seconds for each failure inside the current window.
  failures: number[];
  // ISO timestamp when the lockout was tripped, null if not locked.
  locked_until: string | null;
  // First-seen and last-seen failure timestamps (ISO).
  first_failure_at: string | null;
  last_failure_at: string | null;
  // For the admin UI: total all-time failures from this IP.
  total_failures: number;
};

type State = {
  ips: Record<string, IpState>;
};

let writeQueue: Promise<void> = Promise.resolve();
let cachedConfig: LockoutConfig | null = null;

async function readState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || !j.ips) return { ips: {} };
    return j as State;
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ips: {} };
    return { ips: {} };
  }
}

async function writeState(s: State): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

function validateConfig(input: unknown): LockoutConfig {
  const c = (input ?? {}) as Partial<LockoutConfig>;
  const threshold = Math.max(1, Math.min(1000, Math.floor(Number(c.threshold ?? DEFAULT_CONFIG.threshold))));
  const window_seconds = Math.max(10, Math.min(86400, Math.floor(Number(c.window_seconds ?? DEFAULT_CONFIG.window_seconds))));
  const cooldown_seconds = Math.max(30, Math.min(86400, Math.floor(Number(c.cooldown_seconds ?? DEFAULT_CONFIG.cooldown_seconds))));
  const enabled = !!c.enabled;
  return { threshold, window_seconds, cooldown_seconds, enabled };
}

export async function getConfig(): Promise<LockoutConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf8");
    cachedConfig = validateConfig(JSON.parse(raw));
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig;
}

export async function setConfig(input: unknown): Promise<LockoutConfig> {
  const next = validateConfig(input);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, CONFIG_FILE);
  cachedConfig = next;
  return next;
}

export function _resetCache(): void {
  cachedConfig = null;
}

function pruneFailures(failures: number[], windowSeconds: number, nowSec: number): number[] {
  const cutoff = nowSec - windowSeconds;
  return failures.filter((t) => t >= cutoff);
}

export type LockoutDecision =
  | { locked: false }
  | { locked: true; retry_after_seconds: number; locked_until: string };

export async function decideLockout(ip: string | null, now: Date = new Date()): Promise<LockoutDecision> {
  if (!ip) return { locked: false };
  const cfg = await getConfig();
  if (!cfg.enabled) return { locked: false };
  const state = await readState();
  const s = state.ips[ip];
  if (!s || !s.locked_until) return { locked: false };
  const until = Date.parse(s.locked_until);
  if (!Number.isFinite(until)) return { locked: false };
  if (until <= now.getTime()) return { locked: false };
  const retryAfter = Math.max(1, Math.ceil((until - now.getTime()) / 1000));
  return { locked: true, retry_after_seconds: retryAfter, locked_until: s.locked_until };
}

export async function recordAuthFailure(ip: string | null, now: Date = new Date()): Promise<void> {
  if (!ip) return;
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  await (writeQueue = writeQueue.then(async () => {
    try {
      const state = await readState();
      // Cap tracked IPs to avoid unbounded growth from random scanners.
      if (!state.ips[ip] && Object.keys(state.ips).length >= MAX_TRACKED_IPS) {
        // Drop the oldest by last_failure_at to make room.
        let oldestIp: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of Object.entries(state.ips)) {
          const t = v.last_failure_at ? Date.parse(v.last_failure_at) : 0;
          if (t < oldestTs) { oldestTs = t; oldestIp = k; }
        }
        if (oldestIp) delete state.ips[oldestIp];
      }
      const nowSec = Math.floor(now.getTime() / 1000);
      const cur: IpState = state.ips[ip] ?? {
        failures: [],
        locked_until: null,
        first_failure_at: null,
        last_failure_at: null,
        total_failures: 0,
      };
      cur.failures = pruneFailures(cur.failures, cfg.window_seconds, nowSec);
      cur.failures.push(nowSec);
      cur.total_failures += 1;
      cur.last_failure_at = now.toISOString();
      if (!cur.first_failure_at) cur.first_failure_at = cur.last_failure_at;
      if (cur.failures.length >= cfg.threshold) {
        const until = new Date(now.getTime() + cfg.cooldown_seconds * 1000);
        cur.locked_until = until.toISOString();
        cur.failures = []; // reset window once locked
      }
      state.ips[ip] = cur;
      await writeState(state);
    } catch {
      // Never let the lockout bookkeeping break a request.
    }
  }));
}

export async function clearAuthFailures(ip: string | null): Promise<void> {
  if (!ip) return;
  await (writeQueue = writeQueue.then(async () => {
    try {
      const state = await readState();
      if (!state.ips[ip]) return;
      // Preserve total_failures + first_failure_at as audit-relevant history,
      // but drop the active counter and unlock so a successful auth resets
      // the brute-force tally for that IP.
      state.ips[ip].failures = [];
      state.ips[ip].locked_until = null;
      await writeState(state);
    } catch {}
  }));
}

export async function unlockIp(ip: string): Promise<boolean> {
  let found = false;
  await (writeQueue = writeQueue.then(async () => {
    try {
      const state = await readState();
      if (!state.ips[ip]) return;
      found = true;
      state.ips[ip].failures = [];
      state.ips[ip].locked_until = null;
      await writeState(state);
    } catch {}
  }));
  return found;
}

export type LockoutEntry = {
  ip: string;
  locked: boolean;
  locked_until: string | null;
  recent_failures: number;
  total_failures: number;
  first_failure_at: string | null;
  last_failure_at: string | null;
};

export async function listLockouts(now: Date = new Date()): Promise<LockoutEntry[]> {
  const cfg = await getConfig();
  const state = await readState();
  const nowSec = Math.floor(now.getTime() / 1000);
  const out: LockoutEntry[] = [];
  for (const [ip, s] of Object.entries(state.ips)) {
    const recent = pruneFailures(s.failures, cfg.window_seconds, nowSec).length;
    const locked = !!(s.locked_until && Date.parse(s.locked_until) > now.getTime());
    out.push({
      ip,
      locked,
      locked_until: s.locked_until,
      recent_failures: recent,
      total_failures: s.total_failures,
      first_failure_at: s.first_failure_at,
      last_failure_at: s.last_failure_at,
    });
  }
  out.sort((a, b) => {
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    const at = a.last_failure_at ? Date.parse(a.last_failure_at) : 0;
    const bt = b.last_failure_at ? Date.parse(b.last_failure_at) : 0;
    return bt - at;
  });
  return out;
}
