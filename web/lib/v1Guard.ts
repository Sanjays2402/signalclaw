// Per-route rate-limit guard for /api/v1/*.
//
// Usage in a route handler:
//
//   const key = await authenticate(extractKey(req));
//   if (!key) { ...401... }
//   // scope check, audit success
//   return enforceRateLimit(req, key, "/api/v1/runs", async () => {
//     // existing handler body returning a NextResponse
//     return NextResponse.json({...});
//   });
//
// On block: returns a 429 with standard headers; the callback is not invoked
// and no audit success line for the actual work is written (the 429 is
// recorded instead).
// On allow: invokes callback, then merges X-RateLimit-* headers into its
// response without mutating its body or status.
import { NextResponse } from "next/server";
import type { StoredKey } from "./keyStore";
import { consume, applyRateHeaders, WINDOW_SECONDS } from "./rateLimitStore";
import { recordAuditEvent } from "./auditStore";

export async function enforceRateLimit(
  req: Request,
  key: StoredKey,
  route: string,
  handler: () => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const decision = await consume(key);
  if (!decision.allowed) {
    const res = NextResponse.json(
      {
        error: {
          code: "rate_limited",
          message: `rate limit exceeded: ${decision.limit} requests per ${WINDOW_SECONDS}s. retry after ${decision.retry_after}s`,
          limit: decision.limit,
          retry_after: decision.retry_after,
        },
      },
      { status: 429 },
    );
    applyRateHeaders(res.headers, decision);
    await recordAuditEvent({
      req,
      route,
      method: (req as any).method ?? "GET",
      status: 429,
      key,
      reason: "rate_limited",
    }).catch(() => {});
    return res;
  }
  const res = await handler();
  applyRateHeaders(res.headers, decision);
  return res;
}
