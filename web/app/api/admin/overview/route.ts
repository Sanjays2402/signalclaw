// Aggregated admin console snapshot. Single, low-cost call so the /admin
// landing page can render workspace security posture without N round trips.
// Gated by the shared `requireAdmin` so the same key/SSO rules that protect
// every other /api/admin/* surface apply here too.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { buildAdminOverview } from "@/lib/adminOverview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/overview";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;
  const url = new URL(req.url);
  const recentRaw = url.searchParams.get("recent");
  const recent = recentRaw ? Number(recentRaw) : 25;
  if (!Number.isFinite(recent) || recent < 1 || recent > 200) {
    return NextResponse.json(
      { error: { code: "bad_request", message: "recent must be an integer between 1 and 200" } },
      { status: 400 },
    );
  }
  try {
    const overview = await buildAdminOverview({ recent });
    return NextResponse.json(overview);
  } catch (e: any) {
    return NextResponse.json(
      { error: { code: "internal_error", message: e?.message ?? "overview failed" } },
      { status: 500 },
    );
  }
}
