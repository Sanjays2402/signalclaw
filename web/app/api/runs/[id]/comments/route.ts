import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/runStore";
import {
  listComments,
  addComment,
  publicView,
  MAX_AUTHOR_LEN,
  MAX_BODY_LEN,
} from "@/lib/commentStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "0.0.0.0";
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");
  const items = await listComments(id);
  return NextResponse.json({ comments: items.map(publicView), count: items.length });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return err(404, "not_found", "run not found");

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "expected an object");
  }
  if (typeof body.body !== "string" || !body.body.trim()) {
    return err(400, "empty_body", "body required");
  }
  if (body.body.length > MAX_BODY_LEN * 2) {
    return err(400, "body_too_long", `body exceeds ${MAX_BODY_LEN} chars`);
  }
  if (body.author !== undefined && typeof body.author !== "string") {
    return err(400, "bad_author", "author must be a string");
  }
  if (typeof body.author === "string" && body.author.length > MAX_AUTHOR_LEN * 2) {
    return err(400, "author_too_long", `author exceeds ${MAX_AUTHOR_LEN} chars`);
  }

  const res = await addComment({
    run_id: id,
    author: body.author,
    body: body.body,
    ip: clientIp(req),
  });
  if (!res.ok) {
    if (res.code === "rate_limited") {
      return err(429, "rate_limited", "too many comments, slow down");
    }
    if (res.code === "empty_body") {
      return err(400, "empty_body", "body required");
    }
    return err(409, "run_full", "comment limit reached for this run");
  }
  return NextResponse.json(publicView(res.comment), { status: 201 });
}
