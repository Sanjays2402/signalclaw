import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// GET /v1/whoami
// Auth: Authorization: Bearer <key>  (any scope)
// Returns a minimal, safe view of the calling key. Useful as a connectivity
// check from CLI or notebooks, and as the worked example in /docs.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  return NextResponse.json({
    id: key.id,
    label: key.label,
    prefix: key.prefix,
    scopes: key.scopes,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    server_time: new Date().toISOString(),
  });
}
