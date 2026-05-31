// File-backed retention policy + sweep engine.
//
// Enterprise procurement (SOC2 CC6, GDPR Art. 5(1)(e), CCPA §1798.105) wants
// a documented data-minimisation control: how long do you keep run history,
// audit logs, and webhook delivery logs? This module is that control.
//
// Policy is stored at web/.data/retention.json. The sweep is idempotent:
// callers may invoke it on a cron, on policy change, and inside list
// handlers (best-effort, throttled) without double-deleting anything.
//
// Values of 0 mean "retain forever" so the default install keeps prior
// behaviour. Values >=1 are enforced.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "retention.json");

export type RetentionPolicy = {
  runs_days: number;
  audit_days: number;
  webhook_deliveries_days: number;
  updated_at: string;
  last_sweep_at: string | null;
  last_sweep_counts: {
    runs: number;
    audit: number;
    webhook_deliveries: number;
  } | null;
};

const DEFAULT_POLICY: RetentionPolicy = {
  runs_days: 0,
  audit_days: 0,
  webhook_deliveries_days: 0,
  updated_at: new Date(0).toISOString(),
  last_sweep_at: null,
  last_sweep_counts: null,
};

const MAX_DAYS = 3650; // 10 years cap. Above this we treat as forever.

function clampDays(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i <= 0) return 0;
  if (i > MAX_DAYS) return MAX_DAYS;
  return i;
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function getPolicy(): Promise<RetentionPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const j = JSON.parse(raw);
    return {
      runs_days: clampDays(j?.runs_days),
      audit_days: clampDays(j?.audit_days),
      webhook_deliveries_days: clampDays(j?.webhook_deliveries_days),
      updated_at:
        typeof j?.updated_at === "string"
          ? j.updated_at
          : DEFAULT_POLICY.updated_at,
      last_sweep_at:
        typeof j?.last_sweep_at === "string" ? j.last_sweep_at : null,
      last_sweep_counts:
        j?.last_sweep_counts && typeof j.last_sweep_counts === "object"
          ? {
              runs: Number(j.last_sweep_counts.runs) || 0,
              audit: Number(j.last_sweep_counts.audit) || 0,
              webhook_deliveries:
                Number(j.last_sweep_counts.webhook_deliveries) || 0,
            }
          : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ...DEFAULT_POLICY };
    throw e;
  }
}

export type PolicyUpdate = Partial<
  Pick<RetentionPolicy, "runs_days" | "audit_days" | "webhook_deliveries_days">
>;

export async function setPolicy(update: PolicyUpdate): Promise<RetentionPolicy> {
  const cur = await getPolicy();
  const next: RetentionPolicy = {
    ...cur,
    runs_days:
      update.runs_days === undefined
        ? cur.runs_days
        : clampDays(update.runs_days),
    audit_days:
      update.audit_days === undefined
        ? cur.audit_days
        : clampDays(update.audit_days),
    webhook_deliveries_days:
      update.webhook_deliveries_days === undefined
        ? cur.webhook_deliveries_days
        : clampDays(update.webhook_deliveries_days),
    updated_at: new Date().toISOString(),
  };
  await writeAtomic(next);
  return next;
}

async function writeAtomic(p: RetentionPolicy) {
  await ensureDir();
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(p, null, 2), "utf8");
  await fs.rename(tmp, POLICY_FILE);
}

export type SweepResult = {
  ran_at: string;
  policy: RetentionPolicy;
  counts: { runs: number; audit: number; webhook_deliveries: number };
};

// Apply the policy. Each field with days >= 1 deletes records older than
// (now - days). Returns counts deleted. Safe to call when policy is all
// zeros (no-op, counts = 0).
export async function runRetentionSweep(): Promise<SweepResult> {
  const policy = await getPolicy();
  const ran_at = new Date().toISOString();
  const counts = { runs: 0, audit: 0, webhook_deliveries: 0 };

  if (policy.runs_days > 0) {
    counts.runs = await sweepRunsFile(policy.runs_days);
  }
  if (policy.audit_days > 0) {
    counts.audit = await sweepAuditFiles(policy.audit_days);
  }
  if (policy.webhook_deliveries_days > 0) {
    counts.webhook_deliveries = await sweepWebhookDeliveriesFile(
      policy.webhook_deliveries_days,
    );
  }

  const persisted: RetentionPolicy = {
    ...policy,
    last_sweep_at: ran_at,
    last_sweep_counts: counts,
  };
  await writeAtomic(persisted);
  return { ran_at, policy: persisted, counts };
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function sweepRunsFile(days: number): Promise<number> {
  const file = path.join(DATA_DIR, "runs.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  let store: any;
  try {
    store = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!store || !Array.isArray(store.runs)) return 0;
  const cutoff = cutoffIso(days);
  const before = store.runs.length;
  store.runs = store.runs.filter(
    (r: any) => typeof r?.created_at === "string" && r.created_at >= cutoff,
  );
  const removed = before - store.runs.length;
  if (removed > 0) {
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmp, file);
  }
  return removed;
}

async function sweepAuditFiles(days: number): Promise<number> {
  const cutoff = cutoffIso(days);
  let total = 0;
  for (const name of ["audit.jsonl", "audit.jsonl.1"]) {
    const file = path.join(DATA_DIR, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") continue;
      throw e;
    }
    const lines = raw.split("\n").filter(Boolean);
    const keep: string[] = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (typeof ev?.ts === "string" && ev.ts < cutoff) {
          removed++;
          continue;
        }
      } catch {
        // keep unparseable lines so we don't silently destroy data
      }
      keep.push(line);
    }
    if (removed > 0) {
      const tmp = file + ".tmp";
      const out = keep.length > 0 ? keep.join("\n") + "\n" : "";
      await fs.writeFile(tmp, out, "utf8");
      await fs.rename(tmp, file);
    }
    total += removed;
  }
  return total;
}

async function sweepWebhookDeliveriesFile(days: number): Promise<number> {
  const file = path.join(DATA_DIR, "webhook-deliveries.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return 0;
    throw e;
  }
  let arr: any;
  try {
    arr = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  const cutoff = cutoffIso(days);
  const before = arr.length;
  const next = arr.filter(
    (d: any) =>
      typeof d?.delivered_at === "string" && d.delivered_at >= cutoff,
  );
  const removed = before - next.length;
  if (removed > 0) {
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, file);
  }
  return removed;
}

// Best-effort throttle: do not sweep more than once per hour from
// list-route invocations. Cron / explicit POSTs ignore this.
let lastAutoSweep = 0;
const AUTO_SWEEP_INTERVAL_MS = 3600_000;

export async function maybeAutoSweep(): Promise<SweepResult | null> {
  const p = await getPolicy();
  if (
    p.runs_days === 0 &&
    p.audit_days === 0 &&
    p.webhook_deliveries_days === 0
  ) {
    return null;
  }
  const now = Date.now();
  if (now - lastAutoSweep < AUTO_SWEEP_INTERVAL_MS) return null;
  lastAutoSweep = now;
  try {
    return await runRetentionSweep();
  } catch {
    return null;
  }
}

// Test helper
export async function _resetAutoSweepThrottle() {
  lastAutoSweep = 0;
}
