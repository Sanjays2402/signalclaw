import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { getRun } from "@/lib/runStore";
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
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "read scope required");
  }
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  const bytes = buildRunPdf(run);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdfFilename(run)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
