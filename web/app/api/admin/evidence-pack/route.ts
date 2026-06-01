// GET /api/admin/evidence-pack
//
// Returns a deterministic .zip evidence bundle for the workspace.
// Admin-gated through the shared requireAdmin so the same audit trail
// every other /api/admin/* surface uses applies here too.
//
// HEAD returns the bundle metadata (filename + size + sha256) without
// transferring the body; useful for the UI to render the download
// button with the right file size before the user clicks.
import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireAdmin } from "@/lib/adminGuard";
import { buildEvidencePack } from "@/lib/evidencePack";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/evidence-pack";

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req, ROUTE, "GET");
  if (gate.denied) return gate.denied;
  try {
    const pack = await buildEvidencePack(gate.key?.id ?? null);
    const sha256 = createHash("sha256").update(pack.buffer).digest("hex");
    // Second audit line so the act of downloading the pack itself is
    // recorded with the bundle hash an auditor can later cross-check
    // against the manifest.json in the archive they were handed.
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "GET",
      status: 200,
      key: gate.key ?? null,
      reason: "evidence-pack.download",
      details: { sha256, bytes: pack.buffer.length, generated_at: pack.generated_at },
    });
    const body = new Uint8Array(pack.buffer);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(pack.buffer.length),
        "Content-Disposition": `attachment; filename="${pack.filename}"`,
        "X-Evidence-Pack-Sha256": sha256,
        "X-Evidence-Pack-Generated-At": pack.generated_at,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: "internal_error", message: e?.message ?? "evidence pack failed" } },
      { status: 500 },
    );
  }
}

// HEAD lets the UI peek at size + hash without actually rebuilding +
// streaming the archive twice. We still rebuild (deterministic is
// cheap, the bundle is small) but we discard the body.
export async function HEAD(req: NextRequest) {
  const gate = await requireAdmin(req, ROUTE, "GET");
  if (gate.denied) {
    return new NextResponse(null, { status: gate.denied.status });
  }
  try {
    const pack = await buildEvidencePack(gate.key?.id ?? null);
    const sha256 = createHash("sha256").update(pack.buffer).digest("hex");
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(pack.buffer.length),
        "X-Evidence-Pack-Sha256": sha256,
        "X-Evidence-Pack-Generated-At": pack.generated_at,
        "X-Evidence-Pack-Filename": pack.filename,
      },
    });
  } catch {
    return new NextResponse(null, { status: 500 });
  }
}
