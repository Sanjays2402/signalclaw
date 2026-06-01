import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import {
  revokeKey,
  extractKey,
  authenticate,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  requestApproval,
  consumeApproval,
  publicView as approvalView,
} from "@/lib/dualControlStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, route: string): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method: "DELETE", status: 200, key: k });
  if (((req).method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, route, ((req).method));
    if (__mfaDenied) return __mfaDenied;
  }
  return null;
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}`;
  const denied = await requireAdmin(req, route);
  if (denied) return denied;

  // Dual-control gate. Skipped in single-admin local mode (no
  // SIGNALCLAW_ADMIN_KEY set) so the dev loop and tests using anonymous
  // local access continue to work. In production posture, a key revoke
  // requires a pre-approved one-time token minted by a second admin.
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    const caller = await authenticate(extractKey(req), { req });
    if (caller) {
      const token = req.headers.get("x-approval-token");
      if (!token) {
        const reason = req.headers.get("x-reason") ?? "key revocation";
        const r = await requestApproval({
          action: "keys.revoke",
          target: id,
          reason,
          requested_by: caller.id,
        });
        if (!r.ok) return err(400, r.code, r.message);
        await recordAuditEvent({
          req,
          route,
          method: "DELETE",
          status: 202,
          key: caller,
          reason: `dual_control:request:keys.revoke`,
          details: { request_id: r.request.id, target: id },
        });
        return NextResponse.json(
          {
            pending_approval: approvalView(r.request),
            message:
              "dual-control approval required. A second admin must approve, then retry with x-approval-token.",
          },
          { status: 202 },
        );
      }
      const c = await consumeApproval({
        action: "keys.revoke",
        target: id,
        token,
        caller: caller.id,
      });
      if (!c.ok) {
        const status =
          c.code === "missing_token" || c.code === "bad_token"
            ? 401
            : c.code === "expired"
              ? 410
              : 409;
        await recordAuditEvent({
          req,
          route,
          method: "DELETE",
          status,
          key: caller,
          reason: `dual_control:consume:${c.code}`,
          details: { target: id },
        });
        return err(status, c.code, c.message);
      }
      await recordAuditEvent({
        req,
        route,
        method: "DELETE",
        status: 200,
        key: caller,
        reason: `dual_control:consume:keys.revoke`,
        details: {
          request_id: c.request.id,
          target: id,
          approved_by: c.request.approved_by,
        },
      });
    }
  }

  const ok = await revokeKey(id);
  if (!ok) return err(404, "not_found", "key not found");
  return NextResponse.json({ ok: true });
}
