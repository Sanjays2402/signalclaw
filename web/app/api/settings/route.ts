import { NextRequest, NextResponse } from "next/server";
import {
  getSettings,
  updateProfile,
  updateNotifications,
} from "@/lib/settingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET() {
  const s = await getSettings();
  return NextResponse.json(s);
}

export async function PATCH(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "expected an object");
  }
  try {
    let out = await getSettings();
    if (body.profile) out = await updateProfile(body.profile);
    if (body.notifications) out = await updateNotifications(body.notifications);
    return NextResponse.json(out);
  } catch (e: any) {
    return err(400, "validation", String(e?.message || e));
  }
}
