import { NextRequest, NextResponse } from "next/server";
import { createAlert, listAlerts, MAX_ALERTS } from "@/lib/alertStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const alerts = await listAlerts();
  return NextResponse.json({ alerts, total: alerts.length, limit: MAX_ALERTS });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const r = await createAlert(body);
  if (!r.ok) return err(r.status, r.err.code, r.err.message);
  await recordSafe({
    kind: "system",
    title: `Alert · armed ${r.alert.ticker}`,
    body: `${r.alert.condition} ${r.alert.value}`,
    href: "/alerts",
  });
  return NextResponse.json({ alert: r.alert }, { status: 201 });
}
