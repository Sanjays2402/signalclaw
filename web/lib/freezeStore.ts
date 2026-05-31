// Workspace emergency freeze (break-glass kill switch).
//
// Procurement reality: enterprise security teams require an instant
// "stop everything" lever for a workspace during a suspected breach,
// credential leak, billing dispute, or compliance review. Per-key
// revocation works key by key. Network policy works by IP. Neither
// reacts in one call. This module is the single switch that halts
// every authenticated /api/v1/* request for the workspace in <1s,
// with full audit, until an admin explicitly unfreezes.
//
// Persisted at <DATA_DIR>/freeze.json. Mutations are audited by the
// caller. The freeze runs INSIDE v1Guard so health/metrics probes
// stay green and admin routes keep working (you still need a way to
// unfreeze yourself).
//
// Returns HTTP 503 with Retry-After: 0 so well-behaved clients back
// off and stop hammering, and an x-workspace-frozen: 1 header for
// dashboards / SDKs that want to surface the state.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const FREEZE_FILE = path.join(DATA_DIR, "freeze.json");

export const MAX_REASON_LEN = 500;

export type FreezeState = {
  frozen: boolean;
  reason: string | null;
  frozen_at: string | null;
  frozen_by: string | null;
  unfrozen_at: string | null;
  unfrozen_by: string | null;
};

const DEFAULT_STATE: FreezeState = {
  frozen: false,
  reason: null,
  frozen_at: null,
  frozen_by: null,
  unfrozen_at: null,
  unfrozen_by: null,
};

function clone(s: FreezeState): FreezeState {
  return { ...s };
}

// In-process cache so the v1 hot path doesn't hit disk on every request.
// Invalidated by mutations through this module. Tests can reset via
// __resetFreezeCache().
let _cache: { state: FreezeState; loadedAt: number } | null = null;
const CACHE_TTL_MS = 1_000;

export function __resetFreezeCache(): void {
  _cache = null;
}

async function readFromDisk(): Promise<FreezeState> {
  try {
    const raw = await fs.readFile(FREEZE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return clone(DEFAULT_STATE);
    return {
      frozen: !!j.frozen,
      reason: typeof j.reason === "string" ? j.reason : null,
      frozen_at: typeof j.frozen_at === "string" ? j.frozen_at : null,
      frozen_by: typeof j.frozen_by === "string" ? j.frozen_by : null,
      unfrozen_at: typeof j.unfrozen_at === "string" ? j.unfrozen_at : null,
      unfrozen_by: typeof j.unfrozen_by === "string" ? j.unfrozen_by : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return clone(DEFAULT_STATE);
    throw e;
  }
}

export async function getFreezeState(): Promise<FreezeState> {
  const now = Date.now();
  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return clone(_cache.state);
  }
  const s = await readFromDisk();
  _cache = { state: s, loadedAt: now };
  return clone(s);
}

async function writeToDisk(s: FreezeState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = FREEZE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
  await fs.rename(tmp, FREEZE_FILE);
  _cache = { state: clone(s), loadedAt: Date.now() };
}

export type FreezeInput = {
  reason: string;
  actor?: string | null;
};

export type UnfreezeInput = {
  actor?: string | null;
};

export type MutationResult =
  | { ok: true; state: FreezeState; before: FreezeState }
  | { ok: false; code: "bad_reason" | "already_frozen" | "not_frozen"; message: string };

export async function freezeWorkspace(input: FreezeInput): Promise<MutationResult> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    return { ok: false, code: "bad_reason", message: "reason is required to freeze a workspace" };
  }
  if (reason.length > MAX_REASON_LEN) {
    return {
      ok: false,
      code: "bad_reason",
      message: `reason must be <= ${MAX_REASON_LEN} characters`,
    };
  }
  const before = await getFreezeState();
  if (before.frozen) {
    return { ok: false, code: "already_frozen", message: "workspace is already frozen" };
  }
  const next: FreezeState = {
    frozen: true,
    reason,
    frozen_at: new Date().toISOString(),
    frozen_by: input.actor ?? null,
    unfrozen_at: null,
    unfrozen_by: null,
  };
  await writeToDisk(next);
  return { ok: true, state: next, before };
}

export async function unfreezeWorkspace(input: UnfreezeInput): Promise<MutationResult> {
  const before = await getFreezeState();
  if (!before.frozen) {
    return { ok: false, code: "not_frozen", message: "workspace is not frozen" };
  }
  const next: FreezeState = {
    frozen: false,
    reason: before.reason,
    frozen_at: before.frozen_at,
    frozen_by: before.frozen_by,
    unfrozen_at: new Date().toISOString(),
    unfrozen_by: input.actor ?? null,
  };
  await writeToDisk(next);
  return { ok: true, state: next, before };
}
