// Auth + audit middleware for /api/v1/* routes.
//
// Combines key authentication, scope checks, and audit-log recording into
// one call so every public endpoint logs *both* successful invocations and
// authn/authz failures. The pattern in routes is:
//
//   const ctx = await guardV1(req, { route: "/api/v1/runs", method: "GET",
//                                    requireScopes: ["read"] });
//   if (!ctx.ok) return ctx.response;
//   // ... do work ...
//   await audit(req, ctx, "/api/v1/runs", "GET", 200);
//   return NextResponse.json(...);
//
// `audit()` is also safe to call from non-v1 admin routes that already have
// a NextResponse — it records the outcome without altering the response.
import { NextResponse } from "next/server";
import { authenticate, extractKey, type StoredKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export type GuardOk = { ok: true; key: StoredKey };
export type GuardFail = { ok: false; response: NextResponse };
export type GuardResult = GuardOk | GuardFail;

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export type GuardOpts = {
  route: string;
  method: string;
  requireScopes?: Array<"read" | "trade" | "admin">; // ANY of these (admin always counts)
};

export async function guardV1(
  req: Request,
  opts: GuardOpts,
): Promise<GuardResult> {
  const key = await authenticate(extractKey(req));
  if (!key) {
    const response = err(401, "unauthorized", "missing or invalid api key");
    await recordAuditEvent({
      req,
      route: opts.route,
      method: opts.method,
      status: 401,
      key: null,
      reason: "unauthorized:missing-or-invalid-key",
    });
    return { ok: false, response };
  }
  const required = opts.requireScopes ?? [];
  if (required.length > 0) {
    const ok = key.scopes.includes("admin") || required.some((s) => key.scopes.includes(s));
    if (!ok) {
      const response = err(
        403,
        "forbidden",
        `requires one of: ${required.join(", ")}`,
      );
      await recordAuditEvent({
        req,
        route: opts.route,
        method: opts.method,
        status: 403,
        key,
        reason: `forbidden:requires:${required.join("|")}`,
        details: { had_scopes: key.scopes },
      });
      return { ok: false, response };
    }
  }
  return { ok: true, key };
}

// Record a successful (or unsuccessful) outcome for a guarded request.
export async function audit(
  req: Request,
  ctx: GuardOk,
  route: string,
  method: string,
  status: number,
  details?: unknown,
  reason?: string,
): Promise<void> {
  await recordAuditEvent({
    req,
    route,
    method,
    status,
    key: ctx.key,
    reason: reason ?? null,
    details,
  });
}

// Standalone helper for admin routes (which use env-admin or unauth in
// local-dev mode). Records whatever key authenticate() resolves, even null.
export async function auditAdmin(
  req: Request,
  route: string,
  method: string,
  status: number,
  reason?: string,
  details?: unknown,
): Promise<void> {
  const key = await authenticate(extractKey(req));
  await recordAuditEvent({
    req,
    route,
    method,
    status,
    key,
    reason: reason ?? null,
    details,
  });
}
