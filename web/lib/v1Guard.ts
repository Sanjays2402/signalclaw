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
import {
  clientIpFromRequest,
  ipMatchesAny,
  parseCidr,
  type ParsedCidr,
} from "./ipMatch";
import { decideKeyIpAllowed } from "./keyIpPolicy";
import { isRouteAllowed } from "./routeAllowlist";
import { reserve as reserveQuota, applyQuotaHeaders } from "./monthlyQuotaStore";
import {
  getRotationPolicy,
  evaluateKeyRotation,
  decideRotationBlock,
  type RotationEvaluation,
} from "./rotationPolicy";
import {
  getResidencyPolicy,
  decideResidency,
  type ResidencyDecision,
} from "./residencyStore";
import {
  getPolicy as getNetworkPolicy,
  decideAllowed as decideNetworkAllowed,
} from "./networkPolicyStore";
import { getFreezeState } from "./freezeStore";

function applyRotationHeaders(headers: Headers, ev: RotationEvaluation): void {
  headers.set("x-key-age-days", String(ev.age_days));
  if (ev.status === "disabled") return;
  if (ev.rotate_by) headers.set("x-key-rotate-by", ev.rotate_by);
  if (ev.days_until_rotation !== null) {
    headers.set(
      "x-key-rotation-days-remaining",
      String(ev.days_until_rotation),
    );
  }
  if (ev.status === "warning" || ev.status === "stale") {
    headers.set("x-key-rotation-status", ev.status);
  }
}

async function enforceRotationPolicy(
  req: Request,
  key: StoredKey,
  route: string,
  method: string,
  requestId: string | undefined,
): Promise<{ block: NextResponse | null; evaluation: RotationEvaluation }> {
  const policy = await getRotationPolicy();
  const decision = decideRotationBlock(key, policy);
  const evaluation = decision.evaluation;
  if (!decision.blocked) return { block: null, evaluation };
  const res = NextResponse.json(
    {
      error: {
        code: "key_rotation_required",
        message:
          `API key exceeds the workspace rotation policy ` +
          `(${evaluation.age_days}d old, max ${policy.max_age_days}d). ` +
          `Rotate it before continuing.`,
        age_days: evaluation.age_days,
        max_age_days: policy.max_age_days,
        rotate_by: evaluation.rotate_by,
      },
    },
    { status: 403 },
  );
  applyRotationHeaders(res.headers, evaluation);
  if (requestId) res.headers.set("x-request-id", requestId);
  await recordAuditEvent({
    req,
    route,
    method,
    status: 403,
    key,
    reason: "key_rotation_required",
    details: {
      age_days: evaluation.age_days,
      max_age_days: policy.max_age_days,
    },
  }).catch(() => {});
  return { block: res, evaluation };
}

// Returns null when the request passes the per-key IP allowlist (including
// the trivial "no allowlist configured" case), or a 403 NextResponse when
// the source IP is blocked. The 403 path also writes a structured audit
// line so operators can see what the key tried to do and from where.
async function enforceKeyIpAllowlist(
  req: Request,
  key: StoredKey,
  route: string,
  method: string,
  requestId: string | undefined,
): Promise<NextResponse | null> {
  const decision = decideKeyIpAllowed(req, key);
  if (decision.allowed) return null;
  const ipPart = decision.reason.split(":")[1] || "unknown";
  const res = NextResponse.json(
    {
      error: {
        code: "ip_not_allowed",
        message:
          ipPart === "unknown"
            ? "source IP could not be determined and this key requires an IP allowlist match"
            : "source IP is not in this key's allowlist",
      },
    },
    { status: 403 },
  );
  if (requestId) res.headers.set("x-request-id", requestId);
  await recordAuditEvent({
    req,
    route,
    method,
    status: 403,
    key,
    reason: decision.reason,
  }).catch(() => {});
  return res;
}

function applyResidencyHeaders(headers: Headers, d: ResidencyDecision): void {
  if (d.mode === "off") return;
  headers.set("x-data-region", d.policy_region);
  headers.set("x-data-region-resolved", d.request_region);
  headers.set("x-data-region-source", d.request_source);
  if (d.status !== "ok") headers.set("x-data-region-status", d.status);
}

// Returns null when the request passes residency (off, matching region,
// monitor-mode mismatch, or read-only mismatch), or a 451 NextResponse
// when an enforce-mode mutating request comes from the wrong region.
async function enforceDataResidency(
  req: Request,
  key: StoredKey,
  route: string,
  method: string,
  requestId: string | undefined,
): Promise<{ block: NextResponse | null; decision: ResidencyDecision }> {
  const policy = await getResidencyPolicy();
  const decision = decideResidency(req, policy, method);
  if (decision.allowed) {
    if (decision.status === "warn") {
      await recordAuditEvent({
        req,
        route,
        method,
        status: 200,
        key,
        reason: "residency_warn",
        details: {
          policy_region: decision.policy_region,
          request_region: decision.request_region,
          source: decision.request_source,
        },
      }).catch(() => {});
    }
    return { block: null, decision };
  }
  const res = NextResponse.json(
    {
      error: {
        code: "residency_violation",
        message:
          `data residency policy blocks this request: workspace pinned to ` +
          `${decision.policy_region}, request resolved to ${decision.request_region}`,
        policy_region: decision.policy_region,
        request_region: decision.request_region,
        request_source: decision.request_source,
      },
    },
    { status: 451 },
  );
  applyResidencyHeaders(res.headers, decision);
  if (requestId) res.headers.set("x-request-id", requestId);
  await recordAuditEvent({
    req,
    route,
    method,
    status: 451,
    key,
    reason: "residency_violation",
    details: {
      policy_region: decision.policy_region,
      request_region: decision.request_region,
      source: decision.request_source,
    },
  }).catch(() => {});
  return { block: res, decision };
}

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
    // Break-glass workspace freeze runs first: if an admin has flipped
    // the kill switch, every authenticated v1 call returns 503 immediately
    // and we never touch rate limits, quotas, residency, or handlers.
    const freeze = await getFreezeState();
    if (freeze.frozen) {
      const res = NextResponse.json(
        {
          error: {
            code: "workspace_frozen",
            message:
              "workspace is under an emergency freeze; contact your administrator",
            frozen_at: freeze.frozen_at,
            reason: freeze.reason,
          },
        },
        { status: 503 },
      );
      res.headers.set("retry-after", "0");
      res.headers.set("x-workspace-frozen", "1");
      if (requestId) res.headers.set("x-request-id", requestId);
      await recordAuditEvent({
        req,
        route,
        method,
        status: 503,
        key,
        reason: "workspace_frozen",
        details: { frozen_at: freeze.frozen_at, frozen_by: freeze.frozen_by },
      }).catch(() => {});
      observeRequest({ method, status: 503, route_class, durationMs: Date.now() - t0 });
      return res;
    }
    const netPolicy = await getNetworkPolicy();
    const netDecision = decideNetworkAllowed(req, netPolicy);
    if (!netDecision.allowed) {
      const res = NextResponse.json(
        {
          error: {
            code: "network_policy_block",
            message:
              netDecision.reason === "no-ip"
                ? "source IP could not be determined and workspace network policy is enforcing"
                : `source IP ${netDecision.ip} is not in the workspace network allowlist`,
          },
        },
        { status: 403 },
      );
      if (requestId) res.headers.set("x-request-id", requestId);
      await recordAuditEvent({
        req,
        route,
        method,
        status: 403,
        key,
        reason: `network_policy_block:${netDecision.reason}`,
      }).catch(() => {});
      observeRequest({ method, status: 403, route_class, durationMs: Date.now() - t0 });
      return res;
    }
    const ipBlock = await enforceKeyIpAllowlist(req, key, route, method, requestId);
    if (ipBlock) {
      observeRequest({ method, status: 403, route_class, durationMs: Date.now() - t0 });
      return ipBlock;
    }
    if (!isRouteAllowed(route, key.route_allowlist)) {
      const res = NextResponse.json(
        {
          error: {
            code: "route_not_allowed",
            message:
              "this API key's route allowlist does not permit " + route,
            route,
          },
        },
        { status: 403 },
      );
      if (requestId) res.headers.set("x-request-id", requestId);
      await recordAuditEvent({
        req,
        route,
        method,
        status: 403,
        key,
        reason: "route_not_allowed",
        details: {
          allowlist_size: Array.isArray(key.route_allowlist)
            ? key.route_allowlist.length
            : 0,
        },
      }).catch(() => {});
      observeRequest({ method, status: 403, route_class, durationMs: Date.now() - t0 });
      return res;
    }
    const rotation = await enforceRotationPolicy(req, key, route, method, requestId);
    if (rotation.block) {
      observeRequest({ method, status: 403, route_class, durationMs: Date.now() - t0 });
      return rotation.block;
    }
    const residency = await enforceDataResidency(req, key, route, method, requestId);
    if (residency.block) {
      observeRequest({ method, status: 451, route_class, durationMs: Date.now() - t0 });
      return residency.block;
    }
    // Monthly per-key quota check runs BEFORE the per-minute rate limit
    // so a tenant that exhausts their contract allowance is told why,
    // not just "slow down".
    const quota = await reserveQuota(key);
    if (!quota.allowed) {
      const res = NextResponse.json(
        {
          error: {
            code: "monthly_quota_exceeded",
            message: `monthly quota exceeded: ${quota.limit} requests in ${quota.period}. resets at ${quota.reset_at}`,
            limit: quota.limit,
            used: quota.used,
            period: quota.period,
            reset_at: quota.reset_at,
          },
        },
        { status: 429 },
      );
      applyQuotaHeaders(res.headers, quota);
      if (requestId) res.headers.set("x-request-id", requestId);
      await recordAuditEvent({
        req,
        route,
        method,
        status: 429,
        key,
        reason: "monthly_quota_exceeded",
      }).catch(() => {});
      observeRequest({ method, status: 429, route_class, durationMs: Date.now() - t0 });
      return res;
    }
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
      applyQuotaHeaders(res.headers, quota);
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
    applyQuotaHeaders(res.headers, quota);
    applyRotationHeaders(res.headers, rotation.evaluation);
    applyResidencyHeaders(res.headers, residency.decision);
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
