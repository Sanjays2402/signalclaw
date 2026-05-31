import { NextRequest, NextResponse } from "next/server";
import { runCheck } from "@/lib/alertStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt);
  } catch {
    return NextResponse.json({ error: { code: "bad_json", message: "body must be JSON" } }, { status: 400 });
  }
  const prices =
    body && typeof body.prices === "object" && body.prices !== null
      ? (body.prices as Record<string, number>)
      : undefined;
  const r = await runCheck(prices);
  if (r.hits.length > 0) {
    await recordSafe({
      kind: "system",
      title: `Alerts · ${r.hits.length} firing`,
      body: r.hits.map((h) => h.ticker).join(", "),
      href: "/alerts",
    });
  }
  return NextResponse.json(r);
}
