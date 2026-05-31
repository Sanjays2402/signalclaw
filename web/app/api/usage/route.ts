import { NextResponse } from "next/server";
import { getUsageSummary } from "@/lib/quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getUsageSummary();
    return NextResponse.json(summary, {
      headers: {
        // Quota meter should always reflect the latest save. No caching.
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: { code: "usage_failed", message: msg } },
      { status: 500 },
    );
  }
}
