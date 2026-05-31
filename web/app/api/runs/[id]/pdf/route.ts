import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runStore";
import { buildRunPdf, pdfFilename } from "@/lib/runPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// GET /api/runs/[id]/pdf -> public PDF download for a shared run.
// Matches the public visibility of /r/[id], no auth required.
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json(
      { error: { code: "not_found", message: "run not found" } },
      { status: 404 },
    );
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
}
