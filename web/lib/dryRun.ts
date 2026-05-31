// Sandbox / dry-run helper for /api/v1 mutating endpoints. The detector lives
// in lib/dryRunCore.ts so it can be unit-tested without NextResponse.
//
// When a request is in dry-run mode, route handlers should:
//   1. Run every input validation that a real call would run.
//   2. Compute the would-be effect (id allocation may be skipped or shown as
//      a preview value).
//   3. Return `dryRunResponse(...)` instead of mutating any store.

import { NextResponse } from "next/server";
import { isDryRun, type WouldEffect } from "./dryRunCore";

export { isDryRun };
export type { WouldEffect };

export function dryRunResponse(
  effect: WouldEffect,
  init?: { status?: number },
): NextResponse {
  const status = init?.status ?? 200;
  const res = NextResponse.json(
    {
      dry_run: true,
      would: effect,
      note:
        "no state was changed. remove ?dry_run=true (or the X-Dry-Run header) to execute.",
    },
    { status },
  );
  res.headers.set("X-Dry-Run", "true");
  return res;
}
