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
import {
  classifyRoute,
  observeRequest,
  incInFlight,
  decInFlight,
} from "./metricsStore";

export async function enforceRateLimit(
  req: Request,
  key: StoredKey,
  route: string,
  handler: () => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const t0 = Date.now();
  incInFlight();
  const method = (req as any).method ?? "GET";
  const route_class = classifyRoute(route);
  const requestId = req.headers.get("x-request-id") || undefined;
  try {
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
      if (requestId) res.headers.set("x-request-id", requestId);
      await recordAuditEvent({
        req,
        route,
        method,
        status: 429,
        key,
        reason: "rate_limited",
      }).catch(() => {});
      observeRequest({ method, status: 429, route_class, durationMs: Date.now() - t0 });
      return res;
    }
    const res = await handler();
    applyRateHeaders(res.headers, decision);
    if (requestId && !res.headers.get("x-request-id")) {
      res.headers.set("x-request-id", requestId);
    }
    observeRequest({ method, status: res.status, route_class, durationMs: Date.now() - t0 });
    return res;
  } catch (e) {
    observeRequest({ method, status: 500, route_class, durationMs: Date.now() - t0 });
    throw e;
  } finally {
    decInFlight();
  }
}
