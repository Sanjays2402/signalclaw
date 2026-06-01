// /api/admin/controls — enterprise control inventory.
//
// One JSON document listing every security/operations control with its
// current status. Backs the /admin/controls UI page. Admin gate + audit on
// every read so the lookup itself shows up in the tamper-evident chain.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { buildAdminIndex } from "@/lib/adminIndex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/controls";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;

  const out = await buildAdminIndex(process.env);
  void guard.key;
  return NextResponse.json(out);
}
