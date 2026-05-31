// Workspace emergency freeze (break-glass kill switch) admin API.
//
// GET    /api/admin/freeze  -> current freeze state
// POST   /api/admin/freeze  -> freeze the workspace { reason }
// DELETE /api/admin/freeze  -> unfreeze the workspace
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set). Mirrors the rest of
// the /api/admin/* surface so a buyer's IT team can drive this with the
// same credential they use for every other workspace setting.
//
// Note: /api/admin/* is NOT gated by the freeze itself by design. A frozen
// workspace must still be able to unfreeze itself; otherwise the kill
// switch becomes a permanent self-lockout.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getFreezeState,
  freezeWorkspace,
  unfreezeWorkspace,
  MAX_REASON_LEN,
} from "@/lib/freezeStore";

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
  const k = await authenticate(extractKey(req));
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
  return { denied: null, key: k };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/freeze";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const state = await getFreezeState();
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json({ ...state, max_reason_len: MAX_REASON_LEN });
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/freeze";
  const { denied, key } = await requireAdmin(req, route, "POST");
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: key ?? null, reason: "bad_json" });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: key ?? null, reason: "bad_body" });
    return err(400, "bad_body", "expected { reason: string }");
  }
  const reason = typeof body.reason === "string" ? body.reason : "";

  const result = await freezeWorkspace({ reason, actor: key?.label ?? null });
  if (!result.ok) {
    const status = result.code === "already_frozen" ? 409 : 400;
    await recordAuditEvent({
      req,
      route,
      method: "POST",
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
    method: "POST",
    status: 200,
    key: key ?? null,
    reason: "workspace_frozen",
    details: {
      before: { frozen: result.before.frozen },
      after: {
        frozen: result.state.frozen,
        frozen_at: result.state.frozen_at,
        reason: result.state.reason,
      },
    },
  });
  return NextResponse.json({ ...result.state, max_reason_len: MAX_REASON_LEN });
}

export async function DELETE(req: NextRequest) {
  const route = "/api/admin/freeze";
  const { denied, key } = await requireAdmin(req, route, "DELETE");
  if (denied) return denied;

  const result = await unfreezeWorkspace({ actor: key?.label ?? null });
  if (!result.ok) {
    const status = result.code === "not_frozen" ? 409 : 400;
    await recordAuditEvent({
      req,
      route,
      method: "DELETE",
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
    method: "DELETE",
    status: 200,
    key: key ?? null,
    reason: "workspace_unfrozen",
    details: {
      before: {
        frozen: result.before.frozen,
        frozen_at: result.before.frozen_at,
      },
      after: { frozen: result.state.frozen, unfrozen_at: result.state.unfrozen_at },
    },
  });
  return NextResponse.json({ ...result.state, max_reason_len: MAX_REASON_LEN });
}
