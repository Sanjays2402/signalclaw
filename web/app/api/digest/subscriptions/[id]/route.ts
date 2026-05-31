import { NextRequest, NextResponse } from "next/server";
import { deleteSub, getSub, updateSub } from "@/lib/digestSubStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const sub = await getSub(id);
  if (!sub) return err(404, "not_found", "Subscription not found.");
  return NextResponse.json(sub);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err(400, "invalid_json", "Body must be JSON.");
  }
  const updated = await updateSub(id, body as never);
  if (!updated) return err(404, "not_found", "Subscription not found.");
  return NextResponse.json(updated);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ok = await deleteSub(id);
  if (!ok) return err(404, "not_found", "Subscription not found.");
  return NextResponse.json({ ok: true });
}
