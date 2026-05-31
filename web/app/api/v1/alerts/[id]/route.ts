import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { deleteAlert } from "@/lib/alertStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// DELETE /v1/alerts/:id  (trade or admin scope)
// Disarms an armed alert. Idempotent: returns 404 if the id is unknown.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to delete alerts");
  }
  await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 200, key });

  const { id } = await ctx.params;
  if (!id || typeof id !== "string") {
    return err(400, "bad_id", "alert id is required");
  }
  const ok = await deleteAlert(id);
  if (!ok) return err(404, "not_found", "alert not found");
  return NextResponse.json({ ok: true, id });
}
