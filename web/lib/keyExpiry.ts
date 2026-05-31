// Pure helpers for API key expiry monitoring.
//
// Procurement reality: enterprise security teams require time-bound
// credentials. This repo already stores `expires_at` per key and refuses
// expired keys at auth time. What it did not have, until now, was a
// surface for "which of my keys are about to lapse" so an operator can
// rotate before automation breaks at 03:00 on a Sunday.
//
// This module is pure and synchronous so the route handler and the UI
// can both call it with the same key list and agree on classifications.
// The route handler is the I/O boundary (`/api/admin/keys/expiring`).
//
// Buckets: expired (already past), critical (<=24h), soon (<=7d),
// upcoming (<=30d), ok (no expiry, or >30d). Window is configurable
// per request but defaults to 30 days, which matches the SOC2 control
// most buyers cite ("credentials reviewed at least monthly").
import type { StoredKey } from "./keyStore.ts";

export type ExpiryBucket = "expired" | "critical" | "soon" | "upcoming" | "ok";

export const EXPIRY_THRESHOLDS_MS = {
  critical: 24 * 60 * 60 * 1000, // 24 hours
  soon: 7 * 24 * 60 * 60 * 1000, // 7 days
  upcoming: 30 * 24 * 60 * 60 * 1000, // 30 days
} as const;

// Upper bound on the `within_days` query parameter the API exposes. A
// year is plenty for a forward-looking key roster and protects against
// pathological inputs.
export const MAX_WITHIN_DAYS = 365;

export type ClassifiedKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  expires_at: string;
  expires_in_ms: number; // negative if already expired
  expires_in_days: number; // rounded toward zero; negative if expired
  bucket: Exclude<ExpiryBucket, "ok">;
  revoked: boolean;
  suspended: boolean;
};

export type ExpirySummary = {
  generated_at: string;
  window_days: number;
  counts: {
    expired: number;
    critical: number;
    soon: number;
    upcoming: number;
    active_with_expiry: number;
    no_expiry: number;
    revoked_or_suspended: number;
  };
  keys: ClassifiedKey[];
};

// Classify a single key. Returns null when the key has no expiry, is
// revoked, or is suspended (those never appear in the watch list; the
// summary counts them separately so the UI can still surface them).
export function classifyKey(
  k: Pick<
    StoredKey,
    "id" | "label" | "prefix" | "scopes" | "expires_at" | "revoked" | "suspended"
  >,
  now: number = Date.now(),
): ClassifiedKey | null {
  if (!k.expires_at) return null;
  if (k.revoked) return null;
  if (k.suspended) return null;
  const t = Date.parse(k.expires_at);
  if (!Number.isFinite(t)) return null;
  const expires_in_ms = t - now;
  const bucket: Exclude<ExpiryBucket, "ok"> =
    expires_in_ms <= 0
      ? "expired"
      : expires_in_ms <= EXPIRY_THRESHOLDS_MS.critical
        ? "critical"
        : expires_in_ms <= EXPIRY_THRESHOLDS_MS.soon
          ? "soon"
          : "upcoming";
  // Round toward zero so "expires in 0 days" means <24h away and a
  // negative value clearly signals already-lapsed.
  const expires_in_days = Math.trunc(expires_in_ms / (24 * 60 * 60 * 1000));
  return {
    id: k.id,
    label: k.label,
    prefix: k.prefix,
    scopes: [...k.scopes],
    expires_at: k.expires_at,
    expires_in_ms,
    expires_in_days,
    bucket,
    revoked: !!k.revoked,
    suspended: !!k.suspended,
  };
}

// Summarize a key set against a sliding window. The window controls which
// "upcoming" entries are returned (default 30 days) but does NOT hide
// already-expired keys: those always surface so an operator notices a
// dead credential that is still configured in a downstream system.
export function summarizeExpiry(
  keys: Array<
    Pick<
      StoredKey,
      "id" | "label" | "prefix" | "scopes" | "expires_at" | "revoked" | "suspended"
    >
  >,
  opts: { now?: number; windowDays?: number } = {},
): ExpirySummary {
  const now = opts.now ?? Date.now();
  const rawWindow = opts.windowDays ?? 30;
  const windowDays = Math.max(
    1,
    Math.min(MAX_WITHIN_DAYS, Math.trunc(rawWindow)),
  );
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  let no_expiry = 0;
  let revoked_or_suspended = 0;
  const classified: ClassifiedKey[] = [];

  for (const k of keys) {
    if (k.revoked || k.suspended) {
      revoked_or_suspended++;
      continue;
    }
    if (!k.expires_at) {
      no_expiry++;
      continue;
    }
    const c = classifyKey(k, now);
    if (c) classified.push(c);
  }

  // Filter to the window: always include expired, otherwise within the
  // configured horizon. Sort soonest-first (most-urgent first), with
  // already-expired keys floated to the top.
  const inWindow = classified.filter(
    (c) => c.expires_in_ms <= 0 || c.expires_in_ms <= windowMs,
  );
  inWindow.sort((a, b) => a.expires_in_ms - b.expires_in_ms);

  const counts = {
    expired: 0,
    critical: 0,
    soon: 0,
    upcoming: 0,
    active_with_expiry: classified.length,
    no_expiry,
    revoked_or_suspended,
  };
  for (const c of inWindow) {
    counts[c.bucket]++;
  }

  return {
    generated_at: new Date(now).toISOString(),
    window_days: windowDays,
    counts,
    keys: inWindow,
  };
}
