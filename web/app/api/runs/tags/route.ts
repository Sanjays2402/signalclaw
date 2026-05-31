import { NextResponse } from "next/server";
import { listTags } from "@/lib/runStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tags = await listTags();
  return NextResponse.json({ tags });
}
