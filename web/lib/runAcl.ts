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
