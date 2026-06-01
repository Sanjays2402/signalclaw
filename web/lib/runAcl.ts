// Per-run RBAC for the /api/v1/runs/* mutation surface.
//
// Policy (intentionally small, no policy engine):
//
//   1. `admin` scope keys can mutate any run.
//   2. Runs created before this feature shipped, or runs created through the
//      local dashboard, have no owner (`created_by_key_id` is null/undefined).
//      Those stay mutable by any `trade`-scoped key so we don't break existing
//      automation or dashboard-created rows.
//   3. Owned runs may only be mutated by the api key that created them. A
//      different `trade` key gets a 403 with code `forbidden:not_owner`.
//
// This module is intentionally pure (no Next imports) so the unit test in
// tests/runAcl.test.mjs can import it via node --experimental-strip-types.
import type { SavedRun } from "./runStore.ts";
import type { StoredKey } from "./keyStore.ts";

export type RunAclDecision =
  | { allowed: true; reason: "admin" | "owner" | "unowned" }
  | { allowed: false; reason: "not_owner"; ownerKeyId: string };

export function decideRunMutation(
  run: Pick<SavedRun, "created_by_key_id">,
  key: Pick<StoredKey, "id" | "scopes">,
): RunAclDecision {
  if (key.scopes.includes("admin")) return { allowed: true, reason: "admin" };
  const owner = run.created_by_key_id ?? null;
  if (!owner) return { allowed: true, reason: "unowned" };
  if (owner === key.id) return { allowed: true, reason: "owner" };
  return { allowed: false, reason: "not_owner", ownerKeyId: owner };
}

// Per-run RBAC for the /api/v1/runs/* READ surface.
//
// Policy mirrors decideRunMutation so list/get/export/pdf can never leak
// another tenant's row to a different API key:
//   1. admin scope sees every run.
//   2. Legacy/dashboard rows (no created_by_key_id) stay readable by any
//      read-scoped key. These predate the per-key tenancy model.
//   3. Otherwise only the api key that created the run can read it.
//
// Callers should translate a denial to HTTP 404 (not 403) so the existence
// of another tenant's run id is not observable via probing.
export function decideRunRead(
  run: Pick<SavedRun, "created_by_key_id">,
  key: Pick<StoredKey, "id" | "scopes">,
): RunAclDecision {
  if (key.scopes.includes("admin")) return { allowed: true, reason: "admin" };
  const owner = run.created_by_key_id ?? null;
  if (!owner) return { allowed: true, reason: "unowned" };
  if (owner === key.id) return { allowed: true, reason: "owner" };
  return { allowed: false, reason: "not_owner", ownerKeyId: owner };
}

// Tenant filter for queryRuns({ ownerFilter }). Admin keys see everything;
// other keys see their own owned runs plus legacy unowned rows.
export type RunOwnerFilter =
  | { mode: "all" }
  | { mode: "owner_or_unowned"; keyId: string };

export function ownerFilterForKey(
  key: Pick<StoredKey, "id" | "scopes">,
): RunOwnerFilter {
  if (key.scopes.includes("admin")) return { mode: "all" };
  return { mode: "owner_or_unowned", keyId: key.id };
}

export function runMatchesOwnerFilter(
  run: Pick<SavedRun, "created_by_key_id">,
  filter: RunOwnerFilter,
): boolean {
  if (filter.mode === "all") return true;
  const owner = run.created_by_key_id ?? null;
  if (!owner) return true;
  return owner === filter.keyId;
}
