import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { getUsageSummary } from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/usage
// Auth: Bearer <key>  (read scope)
// Returns the free-tier quota meter so paying integrations can show usage
// and warn users before they hit the cap.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "read scope required");
  }
  const summary = await getUsageSummary();
  return NextResponse.json(summary);
}
