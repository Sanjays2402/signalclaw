import { NextRequest, NextResponse } from "next/server";
import { queryActivity, markAllRead, clearAll } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function intParam(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind") ?? undefined;
  const unreadOnly = sp.get("unread") === "1" || sp.get("unread") === "true";
  const limit = intParam(sp.get("limit"), 25);
  const offset = intParam(sp.get("offset"), 0);
  const out = await queryActivity({ kind, unreadOnly, limit, offset });
  return NextResponse.json({
    events: out.events,
    total: out.total,
    unread: out.unread,
    limit: out.limit,
    offset: out.offset,
    has_more: out.offset + out.events.length < out.total,
  });
}

export async function PATCH(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body, default action is mark-all-read */
  }
  const action = typeof body?.action === "string" ? body.action : "mark_all_read";
  if (action === "mark_all_read") {
    const n = await markAllRead();
    return NextResponse.json({ updated: n });
  }
  return err(400, "bad_action", "unknown action");
}

export async function DELETE() {
  const n = await clearAll();
  return NextResponse.json({ deleted: n });
}
