import { NextResponse } from "next/server";
import { exportAccount } from "@/lib/settingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const bundle = await exportAccount();
  const body = JSON.stringify(bundle, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="signalclaw-account-${new Date()
        .toISOString()
        .slice(0, 10)}.json"`,
    },
  });
}
