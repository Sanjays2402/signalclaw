// Outbound webhook egress policy management.
//
// GET  /api/admin/webhooks/egress-policy  -> current policy
// PUT  /api/admin/webhooks/egress-policy  -> { allow_private?: boolean, cidrs?: string[] }
//
// Auth mirrors /api/admin/keys: in local single-user mode (no
// SIGNALCLAW_ADMIN_KEY env) the routes are open so a fresh install can
// configure egress. With the env set, an admin-scoped key is required.
// Every successful change writes a before/after diff to the audit log.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { getPolicy, setPolicy, publicPolicy, type EgressPolicy } from "@/lib/egressPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/webhooks/egress-policy";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<{ denied: NextResponse | null; actor: string | null }> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return { denied: null, actor: k?.id ?? null };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), actor: null };
  }
  return { denied: null, actor: k.id };
}

export async function GET(req: NextRequest) {
  const { denied } = await requireAdmin(req, "GET");
  if (denied) return denied;
  const p = await getPolicy();
  return NextResponse.json(publicPolicy(p));
}

function diff(before: EgressPolicy, after: EgressPolicy): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  if (before.allow_private !== after.allow_private) {
    changed.allow_private = { from: before.allow_private, to: after.allow_private };
  }
  const sameCidrs =
    before.cidrs.length === after.cidrs.length &&
    before.cidrs.every((c, i) => c === after.cidrs[i]);
  if (!sameCidrs) {
    changed.cidrs = { from: before.cidrs, to: after.cidrs };
  }
  return changed;
}

export async function PUT(req: NextRequest) {
  const { denied, actor } = await requireAdmin(req, "PUT");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (body !== null && typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }
  if (
    body?.allow_private !== undefined &&
    typeof body.allow_private !== "boolean"
  ) {
    return err(400, "bad_allow_private", "allow_private must be a boolean");
  }
  const out = await setPolicy(
    {
      allow_private: body?.allow_private,
      cidrs: body?.cidrs,
    },
    actor,
  );
  if (!out.ok) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "PUT",
      status: 400,
      key: null,
      reason: out.code,
    });
    return err(400, out.code, out.error);
  }
  const changed = diff(out.before, out.policy);
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "PUT",
    status: 200,
    key: null,
    reason: "egress.policy.updated",
    details: changed,
  });
  return NextResponse.json(publicPolicy(out.policy));
}
