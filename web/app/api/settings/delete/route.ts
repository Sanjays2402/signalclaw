import { NextRequest, NextResponse } from "next/server";
import { deleteAccount } from "@/lib/settingsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Two-step confirm: caller must POST { confirm: "DELETE" } to actually wipe.
export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || body.confirm !== "DELETE") {
    return err(
      400,
      "confirm_required",
      'send { "confirm": "DELETE" } to permanently wipe local account data',
    );
  }
  const out = await deleteAccount();
  return NextResponse.json(out);
}
