// Per-workspace concurrent request limit admin API.
//
// GET    /api/admin/concurrency  -> current policy + live in-flight gauge
// PUT    /api/admin/concurrency  -> set limit { limit: number }
// DELETE /api/admin/concurrency  -> clear the limit
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set). Mirrors the rest of
// the /api/admin/* surface so a buyer's IT team can drive this with the
// same credential they use for every other workspace setting. Mutating
// methods require step-up MFA.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getConcurrencyPolicy,
  setConcurrencyPolicy,
  clearConcurrencyPolicy,
  getInFlight,
  MIN_LIMIT,
  MAX_LIMIT,
} from "@/lib/concurrencyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  route: string,
  method: string,
): Promise<{ denied: NextResponse | null; key: any }> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method, status: 200, key: k, reason: "local-mode" });
    return { denied: null, key: k };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), key: k };
  }
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, k, route, method);
    if (mfaDenied) return { denied: mfaDenied, key: k };
  }
  return { denied: null, key: k };
}

function envelope(policy: Awaited<ReturnType<typeof getConcurrencyPolicy>>) {
  return {
    ...policy,
    in_flight: getInFlight(),
    min_limit: MIN_LIMIT,
    max_limit: MAX_LIMIT,
  };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/concurrency";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const policy = await getConcurrencyPolicy();
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json(envelope(policy));
}

export async function PUT(req: NextRequest) {
  const route = "/api/admin/concurrency";
  const { denied, key } = await requireAdmin(req, route, "PUT");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_json" });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_body" });
    return err(400, "bad_body", "expected { limit: number }");
  }
  const result = await setConcurrencyPolicy({ limit: body.limit, actor: key?.label ?? null });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method: "PUT",
      status: 400,
      key: key ?? null,
      reason: result.code,
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: key ?? null,
    reason: "concurrency_limit_set",
    details: { before: result.before.limit, after: result.policy.limit },
  });
  return NextResponse.json(envelope(result.policy));
}

export async function DELETE(req: NextRequest) {
  const route = "/api/admin/concurrency";
  const { denied, key } = await requireAdmin(req, route, "DELETE");
  if (denied) return denied;
  const result = await clearConcurrencyPolicy({ actor: key?.label ?? null });
  await recordAuditEvent({
    req,
    route,
    method: "DELETE",
    status: 200,
    key: key ?? null,
    reason: "concurrency_limit_cleared",
    details: { before: result.before.limit },
  });
  return NextResponse.json(envelope(result.policy));
}
