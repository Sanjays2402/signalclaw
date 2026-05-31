// Workspace-level network policy admin API.
//
// GET  /api/admin/network-policy  -> current policy
// PUT  /api/admin/network-policy  -> replace enabled + cidrs
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set). Mirrors the rest of
// the /api/admin/* surface so a buyer's IT team can drive this with the
// same credential they use for every other workspace setting.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getPolicy,
  updatePolicy,
  MAX_CIDRS,
  type NetworkPolicy,
} from "@/lib/networkPolicyStore";

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
  if ((method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, route, (method));
    if (__mfaDenied) return { denied: __mfaDenied, key: k };
  }
  return { denied: null, key: k };
}

function withMax(p: NetworkPolicy) {
  return { ...p, max_cidrs: MAX_CIDRS };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/network-policy";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const policy = await getPolicy();
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json(withMax(policy));
}

export async function PUT(req: NextRequest) {
  const route = "/api/admin/network-policy";
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
    return err(400, "bad_body", "expected { enabled: boolean, cidrs: string[] }");
  }
  const enabled = !!body.enabled;
  const cidrs = body.cidrs;

  const result = await updatePolicy({ enabled, cidrs, actor: key?.label ?? null });
  if (!result.ok) {
    const status = result.code === "empty_allowlist" ? 400 : 400;
    await recordAuditEvent({
      req,
      route,
      method: "PUT",
      status,
      key: key ?? null,
      reason: result.code,
      details: { message: result.message },
    });
    return err(status, result.code, result.message);
  }

  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: key ?? null,
    reason: "network_policy_updated",
    details: {
      before: { enabled: result.before.enabled, cidrs: result.before.cidrs },
      after: { enabled: result.policy.enabled, cidrs: result.policy.cidrs },
    },
  });
  return NextResponse.json(withMax(result.policy));
}
