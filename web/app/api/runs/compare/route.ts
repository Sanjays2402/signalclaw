import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runStore";
import { regimeMix, pctChange, mixDiff, isValidRunId } from "@/lib/compare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /api/runs/compare?a=ID&b=ID
// Returns two saved runs plus a small comparison summary.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const a = (sp.get("a") ?? "").trim();
  const b = (sp.get("b") ?? "").trim();
  if (!a || !b) return err(400, "missing_ids", "provide a and b query params");
  if (!isValidRunId(a) || !isValidRunId(b)) {
    return err(400, "bad_id", "ids must match [A-Za-z0-9_-]{6,64}");
  }
  if (a === b) return err(400, "same_id", "a and b must be different runs");

  const [ra, rb] = await Promise.all([getRun(a), getRun(b)]);
  if (!ra) return err(404, "a_not_found", `run a=${a} not found`);
  if (!rb) return err(404, "b_not_found", `run b=${b} not found`);

  const ca = regimeMix(ra.payload);
  const cb = regimeMix(rb.payload);

  return NextResponse.json({
    a: ra,
    b: rb,
    summary: {
      a: {
        bars: ra.payload.dates.length,
        mix: ca.mix,
        regime: ra.payload.snapshot?.label ?? null,
        confidence: ra.payload.snapshot?.confidence ?? null,
        pct_change: pctChange(ra.payload.close),
      },
      b: {
        bars: rb.payload.dates.length,
        mix: cb.mix,
        regime: rb.payload.snapshot?.label ?? null,
        confidence: rb.payload.snapshot?.confidence ?? null,
        pct_change: pctChange(rb.payload.close),
      },
      mix_diff: mixDiff(ca.mix, cb.mix),
    },
  });
}
