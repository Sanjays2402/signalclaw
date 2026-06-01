import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { getRun } from "@/lib/runStore";
import { decideRunRead } from "@/lib/runAcl";
import { buildRunPdf, pdfFilename } from "@/lib/runPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/runs/:id/pdf  (read scope)
// Returns the same PDF report as the public /api/runs/:id/pdf route,
// but gated by a minted API key so customers can pipe it into their
// own reporting flows with curl.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]/pdf", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs/[id]/pdf", method: req.method, status: 403, key, reason: "forbidden:read-required" });
    return err(403, "forbidden", "read scope required");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs/[id]/pdf", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs/[id]/pdf", async () => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  const readAcl = decideRunRead(run, key);
  if (!readAcl.allowed) {
    await recordAuditEvent({
      req,
      route: "/api/v1/runs/[id]/pdf",
      method: req.method,
      status: 404,
      key,
      reason: "forbidden:not_owner",
      details: { run_id: id, owner_key_id: readAcl.ownerKeyId },
    });
    return err(404, "not_found", "run not found");
  }
  const bytes = buildRunPdf(run);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFilename(run)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });

  });
}
