import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { deleteAlert, listAlerts } from "@/lib/alertStore";
import { isDryRun, dryRunResponse } from "@/lib/dryRun";
import { withIdempotency } from "@/lib/idempotency";

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
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to delete alerts");
  }
  await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/alerts/[id]", async () => {
  const raw = await req.text();
  return withIdempotency(req, key, "/api/v1/alerts/[id]", raw, async () => {

  const { id } = await ctx.params;
  if (!id || typeof id !== "string") {
    return err(400, "bad_id", "alert id is required");
  }
  if (isDryRun(req)) {
    const all = await listAlerts();
    const existing = all.find((a) => a.id === id);
    if (!existing) return err(404, "not_found", "alert not found");
    const effect = {
      action: "delete",
      resource: "alert",
      id,
      preview: { ticker: existing.ticker, condition: existing.condition, value: existing.value },
    };
    await recordAuditEvent({ req, route: "/api/v1/alerts/[id]", method: req.method, status: 200, key, reason: "dry_run", details: { would: effect } });
    return dryRunResponse(effect, { status: 200 });
  }
  const ok = await deleteAlert(id);
  if (!ok) return err(404, "not_found", "alert not found");
  return NextResponse.json({ ok: true, id });

  });
  });
}
