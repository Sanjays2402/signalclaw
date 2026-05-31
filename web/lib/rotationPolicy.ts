// Workspace-wide API key rotation policy.
//
// Enterprise procurement and SOC2 control CC6.1 require that long-lived
// credentials rotate on a schedule. This module is the policy. The actual
// enforcement happens in v1Guard.enforceRotationPolicy, which calls
// `evaluateKeyRotation(key, policy)` on every authenticated /api/v1/*
// request. Stale keys are blocked with a structured 403 + audit line; keys
// within the warning window pass through with X-Key-Rotate-* headers so
// well-behaved clients can rotate before the cutoff.
//
// Policy state lives at .data/rotation-policy.json. Defaults come from the
// SIGNALCLAW_MAX_KEY_AGE_DAYS / SIGNALCLAW_KEY_ROTATION_WARN_DAYS env vars
// so existing installs are unaffected until an operator opts in. A value
// of 0 for max_age_days means "no policy" (back-compat).
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StoredKey } from "./keyStore";

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "rotation-policy.json");

export type RotationPolicy = {
  // Maximum credential age in days before authentication is denied.
  // 0 disables the policy.
  max_age_days: number;
  // Days before cutoff during which the warning headers/badge appear.
  warn_days: number;
  updated_at: string;
  updated_by: string | null;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function defaultPolicy(): RotationPolicy {
  return {
    max_age_days: envInt("SIGNALCLAW_MAX_KEY_AGE_DAYS", 0),
    warn_days: envInt("SIGNALCLAW_KEY_ROTATION_WARN_DAYS", 7),
    updated_at: "1970-01-01T00:00:00.000Z",
    updated_by: null,
  };
}

function normalize(p: Partial<RotationPolicy>): RotationPolicy {
  const d = defaultPolicy();
  const max_age_days = Number.isFinite(p.max_age_days as number)
    ? Math.max(0, Math.floor(p.max_age_days as number))
    : d.max_age_days;
  const warn_days = Number.isFinite(p.warn_days as number)
    ? Math.max(0, Math.floor(p.warn_days as number))
    : d.warn_days;
  return {
    max_age_days,
    warn_days,
    updated_at: typeof p.updated_at === "string" ? p.updated_at : d.updated_at,
    updated_by: typeof p.updated_by === "string" ? p.updated_by : null,
  };
}

export async function getRotationPolicy(): Promise<RotationPolicy> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const j = JSON.parse(raw);
    return normalize(j || {});
  } catch (e: any) {
    if (e?.code === "ENOENT") return defaultPolicy();
    throw e;
  }
}

export type PolicyInput = {
  max_age_days?: number;
  warn_days?: number;
  updated_by?: string | null;
};

export async function setRotationPolicy(
  input: PolicyInput,
): Promise<RotationPolicy> {
  const current = await getRotationPolicy();
  const max_age_days = input.max_age_days !== undefined
    ? input.max_age_days
    : current.max_age_days;
  const warn_days = input.warn_days !== undefined
    ? input.warn_days
    : current.warn_days;
  if (!Number.isFinite(max_age_days) || max_age_days < 0) {
    throw new Error("invalid_policy: max_age_days must be a non-negative integer");
  }
  if (!Number.isFinite(warn_days) || warn_days < 0) {
    throw new Error("invalid_policy: warn_days must be a non-negative integer");
  }
  const next: RotationPolicy = {
    max_age_days: Math.floor(max_age_days),
    warn_days: Math.floor(warn_days),
    updated_at: new Date().toISOString(),
    updated_by: input.updated_by ?? null,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, DATA_FILE);
  return next;
}

const MS_PER_DAY = 86_400_000;

export type RotationStatus = "ok" | "warning" | "stale" | "disabled";

export type RotationEvaluation = {
  status: RotationStatus;
  // Whole days since the key was minted, floored. Always reported, even
  // when the policy is disabled, so dashboards can show key age.
  age_days: number;
  // Whole days until the policy-driven cutoff. Negative when stale.
  // null when the policy is disabled.
  days_until_rotation: number | null;
  // Absolute timestamp at which this key becomes stale under the current
  // policy. null when disabled.
  rotate_by: string | null;
  policy: RotationPolicy;
};

// Pure function. Caller provides the policy so we don't hit disk on the
// hot authentication path more than once per request.
export function evaluateKeyRotation(
  key: Pick<StoredKey, "created_at">,
  policy: RotationPolicy,
  now: Date = new Date(),
): RotationEvaluation {
  const t0 = Date.parse(key.created_at);
  const ageMs = Number.isFinite(t0) ? Math.max(0, now.getTime() - t0) : 0;
  const age_days = Math.floor(ageMs / MS_PER_DAY);

  if (policy.max_age_days <= 0) {
    return {
      status: "disabled",
      age_days,
      days_until_rotation: null,
      rotate_by: null,
      policy,
    };
  }

  const rotate_by = Number.isFinite(t0)
    ? new Date(t0 + policy.max_age_days * MS_PER_DAY).toISOString()
    : null;
  const days_until_rotation = policy.max_age_days - age_days;
  let status: RotationStatus = "ok";
  if (days_until_rotation <= 0) status = "stale";
  else if (days_until_rotation <= policy.warn_days) status = "warning";

  return { status, age_days, days_until_rotation, rotate_by, policy };
}

// Pure deny-decision used by v1Guard.enforceRotationPolicy. Lives here so
// it can be tested without importing the Next.js runtime.
export type RotationDecision = {
  blocked: boolean;
  evaluation: RotationEvaluation;
  reason?: "key_rotation_required";
};

export function decideRotationBlock(
  key: Pick<StoredKey, "created_at">,
  policy: RotationPolicy,
  now: Date = new Date(),
): RotationDecision {
  const evaluation = evaluateKeyRotation(key, policy, now);
  if (evaluation.status === "stale") {
    return { blocked: true, evaluation, reason: "key_rotation_required" };
  }
  return { blocked: false, evaluation };
}
