// Pure helpers for API key dormancy monitoring.
//
// Procurement reality: SOC2 CC6.1 / ISO 27001 A.9.2.5 require periodic
// review of access rights. A credential that has not been used in
// months is a liability: it has all of the access it was granted on
// day one, none of the recent observation that would let an operator
// spot misuse, and no business owner watching it. This module
// classifies each key by how long it has been silent so the admin
// console can drive a rotate-or-revoke review queue.
//
// Pure and synchronous so the route handler and the UI agree on
// classification. The I/O boundary is `/api/admin/keys/dormant`.
//
// Buckets: active (<30d), quiet (30..89d), dormant (90..179d),
// abandoned (>=180d), revoked (already revoked or expired so the
// surface does not nag), unknown (no usable anchor). A key that has
// never been used is bucketed by the age of its `created_at` so a
// minted-and-forgotten credential still surfaces.
import type { StoredKey } from "./keyStore.ts";

export type DormancyBucket =
  | "active"
  | "quiet"
  | "dormant"
  | "abandoned"
  | "revoked"
  | "unknown";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DORMANCY_THRESHOLDS_MS = {
  quiet: 30 * DAY_MS,
  dormant: 90 * DAY_MS,
  abandoned: 180 * DAY_MS,
} as const;

// Upper bound on the `within_days` query parameter. A year is plenty
// of headroom for any practical operator review cadence.
export const MAX_DORMANT_WITHIN_DAYS = 365;

export const DEFAULT_DORMANT_WITHIN_DAYS = 30;

export type ClassifiedDormantKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  silent_ms: number;
  silent_days: number;
  bucket: Exclude<DormancyBucket, "active" | "revoked" | "unknown">;
  never_used: boolean;
  revoked: boolean;
};

export type DormancySummary = {
  generated_at: string;
  window_days: number;
  counts: {
    quiet: number;
    dormant: number;
    abandoned: number;
    never_used: number;
    active: number;
    revoked: number;
    unknown: number;
  };
  keys: ClassifiedDormantKey[];
};

function parseIso(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

// Pick the anchor for measuring silence: last_used_at if we have it,
// otherwise created_at (so never-used keys still surface). Returns the
// epoch millisecond timestamp or null if neither parses.
export function silenceAnchorMs(k: StoredKey): number | null {
  return parseIso(k.last_used_at) ?? parseIso(k.created_at);
}

export function dormancyBucket(k: StoredKey, nowMs: number = Date.now()): DormancyBucket {
  if (k.revoked) return "revoked";
  if (k.suspended) return "revoked";
  if (k.expires_at) {
    const exp = parseIso(k.expires_at);
    if (exp !== null && exp <= nowMs) return "revoked";
  }
  const anchor = silenceAnchorMs(k);
  if (anchor === null) return "unknown";
  const silent = Math.max(0, nowMs - anchor);
  if (silent >= DORMANCY_THRESHOLDS_MS.abandoned) return "abandoned";
  if (silent >= DORMANCY_THRESHOLDS_MS.dormant) return "dormant";
  if (silent >= DORMANCY_THRESHOLDS_MS.quiet) return "quiet";
  return "active";
}

export function summarizeDormancy(
  keys: ReadonlyArray<StoredKey>,
  opts: { windowDays?: number; nowMs?: number } = {},
): DormancySummary {
  const nowMs = opts.nowMs ?? Date.now();
  const windowDays = Math.max(1, Math.min(MAX_DORMANT_WITHIN_DAYS,
    Math.floor(opts.windowDays ?? DEFAULT_DORMANT_WITHIN_DAYS)));
  const windowMs = windowDays * DAY_MS;

  const counts = {
    quiet: 0,
    dormant: 0,
    abandoned: 0,
    never_used: 0,
    active: 0,
    revoked: 0,
    unknown: 0,
  };
  const classified: ClassifiedDormantKey[] = [];

  for (const k of keys) {
    const bucket = dormancyBucket(k, nowMs);
    counts[bucket] += 1;
    if (bucket === "active" || bucket === "revoked" || bucket === "unknown") continue;
    const anchor = silenceAnchorMs(k);
    const silentMs = anchor === null ? 0 : Math.max(0, nowMs - anchor);
    if (silentMs < windowMs) continue;
    const neverUsed = !k.last_used_at;
    if (neverUsed) counts.never_used += 1;
    classified.push({
      id: k.id,
      label: k.label,
      prefix: k.prefix,
      scopes: [...k.scopes],
      last_used_at: k.last_used_at,
      created_at: k.created_at,
      silent_ms: silentMs,
      silent_days: Math.floor(silentMs / DAY_MS),
      bucket,
      never_used: neverUsed,
      revoked: !!k.revoked,
    });
  }

  // Longest-silent first so the worst offenders bubble to the top of
  // the operator review queue.
  classified.sort((a, b) => b.silent_ms - a.silent_ms);

  return {
    generated_at: new Date(nowMs).toISOString(),
    window_days: windowDays,
    counts,
    keys: classified,
  };
}
