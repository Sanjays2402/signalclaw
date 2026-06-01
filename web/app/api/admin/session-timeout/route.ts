// /api/admin/session-timeout — get and update the SSO session
// idle + absolute timeout policy. Admin gate + MFA on PUT, full audit.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import { getPolicy, updatePolicy } from "@/lib/sessionTimeoutPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/session-timeout";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;
  const policy = await getPolicy();
  return NextResponse.json({ policy });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "PUT");
  if (guard.denied) return guard.denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "invalid_body", "request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const before = await getPolicy();
  const actor = guard.key?.id ?? "local";
  const result = await updatePolicy({
    enforce: typeof b.enforce === "boolean" ? b.enforce : undefined,
    idle_timeout_s: typeof b.idle_timeout_s === "number" ? b.idle_timeout_s : undefined,
    absolute_timeout_s: typeof b.absolute_timeout_s === "number" ? b.absolute_timeout_s : undefined,
    actor,
  });
  if (!result.ok) {
    await recordAuditEvent({
      req, route: ROUTE, method: "PUT", status: 400, key: guard.key,
      reason: `session-timeout-update-rejected:${result.code}`,
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req, route: ROUTE, method: "PUT", status: 200, key: guard.key,
    reason: `session-timeout-update:enforce=${before.enforce}->${result.policy.enforce}:idle=${before.idle_timeout_s}->${result.policy.idle_timeout_s}:absolute=${before.absolute_timeout_s}->${result.policy.absolute_timeout_s}`,
  });
  return NextResponse.json({ policy: result.policy });
}
