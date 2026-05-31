import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { deleteRun, getRun } from "@/lib/runStore";
import { recordSafe } from "@/lib/activityStore";
import { isDryRun, dryRunResponse } from "@/lib/dryRun";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/runs/:id  (read scope)
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 403, key, reason: "forbidden:read-required" });
    return err(403, "forbidden", "read scope required");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs/[id]", async () => {

  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  return NextResponse.json({
    id: run.id,
    label: run.label,
    ticker: run.ticker,
    lookback_days: run.lookback_days,
    created_at: run.created_at,
    payload: run.payload,
    share_url: `/r/${run.id}`,
  });

  });
}

// DELETE /v1/runs/:id  (trade or admin scope)
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const key = await authenticate(extractKey(req));
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to delete runs");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs/[id]", async () => {
  const raw = await req.text();
  return withIdempotency(req, key, "/api/v1/runs/[id]", raw, async () => {
  const { id } = await ctx.params;
  const existing = await getRun(id);
  if (!existing) return err(404, "not_found", "run not found");
  if (isDryRun(req)) {
    const effect = {
      action: "delete",
      resource: "run",
      id,
      preview: { label: existing.label, ticker: existing.ticker },
    };
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]", method: req.method, status: 200, key, reason: "dry_run", details: { would: effect } });
    return dryRunResponse(effect, { status: 200 });
  }
  const ok = await deleteRun(id);
  if (!ok) return err(500, "delete_failed", "could not delete run");
  await recordSafe({
    kind: "run.deleted",
    title: `API run deleted \u00b7 ${existing.ticker}`,
    body: existing.label,
    href: "/history",
  });
  return NextResponse.json({ id, deleted: true });

  });
  });
}
