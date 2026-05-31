import { NextResponse } from "next/server";
import { clearHistory } from "@/lib/alertStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  const removed = await clearHistory();
  return NextResponse.json({ ok: true, removed });
}
