import { NextRequest, NextResponse } from "next/server";
import {
  listKeys,
  createKey,
  publicView,
  extractKey,
  authenticate,
  type Scope,
} from "@/lib/keyStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// In local single-user mode (default) the keys page is unauthenticated so a
// fresh install can mint its first key. Set SIGNALCLAW_ADMIN_KEY in the env
// to require an admin key on these endpoints (production posture).
async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  if (!process.env.SIGNALCLAW_ADMIN_KEY) return null;
  const k = await authenticate(extractKey(req));
  if (!k || !k.scopes.includes("admin")) {
    return err(403, "forbidden", "admin scope required");
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const keys = await listKeys();
  return NextResponse.json({ keys: keys.map(publicView) });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const label = typeof body?.label === "string" ? body.label : "";
  const scopesIn = Array.isArray(body?.scopes) ? body.scopes : [];
  const scopes = scopesIn.filter(
    (s: unknown): s is Scope => s === "read" || s === "trade",
  );
  if (label.trim().length === 0) {
    return err(400, "bad_label", "label must be a non-empty string");
  }
  if (label.length > 80) {
    return err(400, "label_too_long", "label exceeds 80 chars");
  }
  const { key, secret } = await createKey({ label, scopes });
  await recordSafe({
    kind: "key.created",
    title: `API key created · ${key.label}`,
    body: `Scopes: ${(key.scopes.length ? key.scopes.join(", ") : "none")}. Prefix ${key.prefix}…`,
    href: "/settings/keys",
  });
  return NextResponse.json({ ...publicView(key), secret });
}
