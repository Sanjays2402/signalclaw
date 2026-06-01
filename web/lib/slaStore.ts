// Per-workspace Service Level Agreement (SLA) commitment register.
//
// Procurement reality: every enterprise MSA negotiation hits an SLA
// addendum. Procurement and vendor-management teams will not sign
// without a written monthly uptime commitment, a tiered incident
// response time matrix, and a credit policy that says what the
// customer gets back when targets are missed. Today SREs write this
// in a Google Doc that diverges from what the product actually does.
//
// This module is the durable, versioned source of truth that pairs
// with the SOC2 evidence pack. Owners set the targets (uptime %,
// response time per severity, credit %), and we keep an append-only
// version history so a buyer can prove "this was the SLA in force on
// 2026-03-15". Nothing here promises uptime we can't deliver: the
// values are owner-supplied, validated, and pinned with a sha256 so
// the customer cannot later claim a different document was in force.
//
// What this is NOT: it is not the uptime monitor itself. Observed
// uptime is reported by /metrics + /healthz from existing
// observability surfaces; this module is the commitment register, not
// the measurement system. Pairing the two is exactly what an auditor
// looks for during a SOC2 CC7 review.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "sla-register.json");

export const SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const MAX_NOTE_LEN = 2000;
export const MAX_CONTACT_LEN = 200;
export const MAX_HISTORY = 200;

// Uptime tier presets used by sales. Stored as basis points (bps) so
// "99.95%" is 9995, avoiding float rounding.
export const UPTIME_BPS_MIN = 9000; // 90.00%
export const UPTIME_BPS_MAX = 9999; // 99.99%

// Response time targets are stored in whole minutes.
export const RESP_MIN_MINUTES = 5;
export const RESP_MAX_MINUTES = 7 * 24 * 60; // one week

// Service credit percentage cap (integer, 0..100).
export const CREDIT_MAX_PCT = 100;

export type ResponseMatrix = {
  sev1: number; // minutes
  sev2: number;
  sev3: number;
  sev4: number;
};

export type CreditTier = {
  // If observed uptime falls below this many bps, customer is
  // entitled to `credit_pct` of monthly fees as service credit.
  below_uptime_bps: number;
  credit_pct: number;
};

export type SlaCommitment = {
  version: number;
  effective_at: string;
  published_by: string;
  published_by_email: string | null;
  // Monthly uptime target, in basis points (e.g. 9995 = 99.95%).
  uptime_target_bps: number;
  // Initial response time targets per severity, in minutes.
  response_targets: ResponseMatrix;
  // Service credit ladder. Evaluated top-down: first matching tier
  // wins. Tiers must be sorted by `below_uptime_bps` descending at
  // write time, enforced by the validator below.
  credit_ladder: CreditTier[];
  // Free-text commitment surface (maintenance window, support
  // channels, exclusions). Hash is pinned so the customer cannot
  // later argue a different document was in force.
  notes: string;
  notes_sha256: string;
  // Operational contacts the customer can escalate to.
  contacts: {
    support_email: string;
    status_page_url: string | null;
    security_email: string | null;
  };
};

export type SlaRegister = {
  current: SlaCommitment | null;
  history: SlaCommitment[];
};

const EMPTY: SlaRegister = { current: null, history: [] };

let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRaw(): Promise<SlaRegister> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    const current = isCommitment(parsed.current) ? parsed.current : null;
    const history = Array.isArray(parsed.history)
      ? parsed.history.filter(isCommitment).slice(0, MAX_HISTORY)
      : [];
    return { current, history };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ...EMPTY };
    throw err;
  }
}

function isCommitment(v: any): v is SlaCommitment {
  return (
    v &&
    typeof v === "object" &&
    typeof v.version === "number" &&
    typeof v.uptime_target_bps === "number" &&
    v.response_targets &&
    typeof v.response_targets === "object" &&
    Array.isArray(v.credit_ladder) &&
    typeof v.notes === "string" &&
    typeof v.notes_sha256 === "string"
  );
}

async function writeAtomic(reg: SlaRegister): Promise<void> {
  await ensureDir();
  const tmp = FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2), "utf8");
  await fs.rename(tmp, FILE);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export type PublishInput = {
  uptime_target_bps: number;
  response_targets: ResponseMatrix;
  credit_ladder: CreditTier[];
  notes: string;
  support_email: string;
  status_page_url?: string | null;
  security_email?: string | null;
  actor_id: string;
  actor_email?: string | null;
};

export type PublishResult =
  | { ok: true; commitment: SlaCommitment }
  | { ok: false; code: string; message: string };

function validate(input: PublishInput): { ok: true } | { ok: false; code: string; message: string } {
  const u = input.uptime_target_bps;
  if (!Number.isInteger(u) || u < UPTIME_BPS_MIN || u > UPTIME_BPS_MAX) {
    return {
      ok: false,
      code: "bad_uptime",
      message: `uptime_target_bps must be an integer between ${UPTIME_BPS_MIN} and ${UPTIME_BPS_MAX}`,
    };
  }
  const r = input.response_targets;
  if (!r || typeof r !== "object") {
    return { ok: false, code: "bad_response", message: "response_targets required" };
  }
  for (const s of SEVERITIES) {
    const v = (r as any)[s];
    if (!Number.isInteger(v) || v < RESP_MIN_MINUTES || v > RESP_MAX_MINUTES) {
      return {
        ok: false,
        code: "bad_response",
        message: `response_targets.${s} must be an integer between ${RESP_MIN_MINUTES} and ${RESP_MAX_MINUTES} minutes`,
      };
    }
  }
  // Higher severity must have an equal-or-shorter response target.
  if (
    r.sev1 > r.sev2 ||
    r.sev2 > r.sev3 ||
    r.sev3 > r.sev4
  ) {
    return {
      ok: false,
      code: "bad_response_order",
      message: "response_targets must be non-decreasing from sev1 to sev4",
    };
  }
  if (!Array.isArray(input.credit_ladder) || input.credit_ladder.length === 0) {
    return { ok: false, code: "bad_ladder", message: "credit_ladder must contain at least one tier" };
  }
  if (input.credit_ladder.length > 10) {
    return { ok: false, code: "bad_ladder", message: "credit_ladder may have at most 10 tiers" };
  }
  let prevBps = Number.POSITIVE_INFINITY;
  let prevPct = -1;
  for (const t of input.credit_ladder) {
    if (
      !t ||
      !Number.isInteger(t.below_uptime_bps) ||
      t.below_uptime_bps < UPTIME_BPS_MIN ||
      t.below_uptime_bps > UPTIME_BPS_MAX
    ) {
      return {
        ok: false,
        code: "bad_ladder",
        message: `credit_ladder.below_uptime_bps must be integer in [${UPTIME_BPS_MIN}, ${UPTIME_BPS_MAX}]`,
      };
    }
    if (!Number.isInteger(t.credit_pct) || t.credit_pct < 1 || t.credit_pct > CREDIT_MAX_PCT) {
      return {
        ok: false,
        code: "bad_ladder",
        message: `credit_ladder.credit_pct must be integer in [1, ${CREDIT_MAX_PCT}]`,
      };
    }
    // Must be sorted by below_uptime_bps DESC and credit_pct ASC so
    // the first match is the largest credit owed.
    if (t.below_uptime_bps >= prevBps) {
      return {
        ok: false,
        code: "bad_ladder_order",
        message: "credit_ladder must be sorted by below_uptime_bps descending",
      };
    }
    if (t.credit_pct <= prevPct) {
      return {
        ok: false,
        code: "bad_ladder_order",
        message: "credit_ladder credit_pct must strictly increase as below_uptime_bps decreases",
      };
    }
    if (t.below_uptime_bps >= input.uptime_target_bps) {
      return {
        ok: false,
        code: "bad_ladder",
        message: "every credit_ladder.below_uptime_bps must be below uptime_target_bps",
      };
    }
    prevBps = t.below_uptime_bps;
    prevPct = t.credit_pct;
  }
  if (typeof input.notes !== "string" || input.notes.length === 0) {
    return { ok: false, code: "bad_notes", message: "notes required" };
  }
  if (input.notes.length > MAX_NOTE_LEN) {
    return { ok: false, code: "bad_notes", message: `notes must be <= ${MAX_NOTE_LEN} chars` };
  }
  if (
    typeof input.support_email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.support_email) ||
    input.support_email.length > MAX_CONTACT_LEN
  ) {
    return { ok: false, code: "bad_contact", message: "support_email must be a valid email" };
  }
  if (
    input.status_page_url != null &&
    input.status_page_url !== "" &&
    !/^https:\/\/[^\s]+$/.test(input.status_page_url)
  ) {
    return { ok: false, code: "bad_contact", message: "status_page_url must be an https URL" };
  }
  if (
    input.security_email != null &&
    input.security_email !== "" &&
    (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.security_email) ||
      input.security_email.length > MAX_CONTACT_LEN)
  ) {
    return { ok: false, code: "bad_contact", message: "security_email must be a valid email" };
  }
  return { ok: true };
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  const check = validate(input);
  if (!check.ok) return check;
  const op = (writeChain = writeChain.then(async () => {
    const reg = await readRaw();
    const nextVersion = (reg.current?.version ?? 0) + 1;
    const commitment: SlaCommitment = {
      version: nextVersion,
      effective_at: new Date().toISOString(),
      published_by: input.actor_id,
      published_by_email: input.actor_email ?? null,
      uptime_target_bps: input.uptime_target_bps,
      response_targets: { ...input.response_targets },
      credit_ladder: input.credit_ladder.map((t) => ({ ...t })),
      notes: input.notes,
      notes_sha256: sha256(input.notes),
      contacts: {
        support_email: input.support_email,
        status_page_url: input.status_page_url || null,
        security_email: input.security_email || null,
      },
    };
    const history = [
      ...(reg.current ? [reg.current] : []),
      ...reg.history,
    ].slice(0, MAX_HISTORY);
    const next: SlaRegister = { current: commitment, history };
    await writeAtomic(next);
    return commitment;
  }));
  return { ok: true, commitment: await (op as Promise<SlaCommitment>) };
}

export async function getState(): Promise<SlaRegister> {
  return await readRaw();
}

// Pure helper: given observed uptime in basis points, return the
// service credit tier owed under the supplied commitment, or null if
// the target was met. Used by /api/admin/sla and unit tests.
export function evaluateCredit(
  commitment: SlaCommitment,
  observed_uptime_bps: number,
): { credit_pct: number; tier_below_uptime_bps: number } | null {
  if (observed_uptime_bps >= commitment.uptime_target_bps) return null;
  // Ladder is stored sorted by below_uptime_bps descending and
  // credit_pct ascending. Walk it bottom-up so the customer is
  // awarded the largest credit they qualify for.
  let owed: { credit_pct: number; tier_below_uptime_bps: number } | null = null;
  for (const tier of commitment.credit_ladder) {
    if (observed_uptime_bps < tier.below_uptime_bps) {
      if (!owed || tier.credit_pct > owed.credit_pct) {
        owed = { credit_pct: tier.credit_pct, tier_below_uptime_bps: tier.below_uptime_bps };
      }
    }
  }
  return owed;
}

// Exposed for tests so they can reset between cases.
export async function __resetForTests(): Promise<void> {
  try {
    await fs.unlink(FILE);
  } catch {
    /* ignore */
  }
}
