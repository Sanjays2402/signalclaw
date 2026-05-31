import { NextRequest, NextResponse } from "next/server";
import {
  listSubs,
  createSub,
  type DigestSubIn,
} from "@/lib/digestSubStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const subscriptions = await listSubs();
  return NextResponse.json({ subscriptions });
}

export async function POST(req: NextRequest) {
  let body: DigestSubIn;
  try {
    body = (await req.json()) as DigestSubIn;
  } catch {
    return err(400, "invalid_json", "Body must be JSON.");
  }
  const result = await createSub(body);
  if (!result.ok) return err(400, "invalid_input", result.error);
  await recordSafe({
    kind: "system",
    title: `Digest subscription created: ${result.subscription.label}`,
    body: `${result.subscription.cadence} cadence to ${result.subscription.url}`,
    href: "/digest",
  });
  return NextResponse.json(result.subscription, { status: 201 });
}
