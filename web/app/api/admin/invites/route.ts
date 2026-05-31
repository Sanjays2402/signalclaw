import { NextRequest, NextResponse } from "next/server";
import {
  createInvite,
  listInvites,
  publicView,
  type InviteScope,
} from "@/lib/inviteStore";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordSafe } from "@/lib/activityStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { getSeatUsage } from "@/lib/seats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, route: string, method: string) {
  const k = await authenticate(extractKey(req));
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method, status: 200, key: k, reason: "local-mode" });
    return { ok: true as const, key: k };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return { ok: false as const, response: err(403, "forbidden", "admin scope required") };
  }
  await recordAuditEvent({ req, route, method, status: 200, key: k });
  return { ok: true as const, key: k };
}

export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req, "/api/admin/invites", "GET");
  if (!gate.ok) return gate.response;
  const [invites, seats] = await Promise.all([listInvites(), getSeatUsage()]);
  return NextResponse.json({
    invites: invites.map(publicView),
    seats: {
      used: seats.used,
      limit: seats.limit,
      remaining: seats.unlimited ? null : seats.remaining,
      unlimited: seats.unlimited,
    },
  });
}

export async function POST(req: NextRequest) {
  const gate = await requireAdmin(req, "/api/admin/invites", "POST");
  if (!gate.ok) return gate.response;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const label = typeof body?.label === "string" ? body.label : "";
  if (label.trim().length === 0) {
    return err(400, "bad_label", "label must be a non-empty string");
  }
  if (label.length > 80) {
    return err(400, "label_too_long", "label exceeds 80 chars");
  }
  const scopesIn = Array.isArray(body?.scopes) ? body.scopes : ["read"];
  const scopes = scopesIn.filter(
    (s: unknown): s is InviteScope => s === "read" || s === "trade",
  );
  if (scopes.length === 0) {
    return err(400, "bad_scopes", "scopes must include at least one of read, trade");
  }
  let max_uses: number | undefined = undefined;
  if (body?.max_uses != null) {
    const n = Number(body.max_uses);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return err(400, "bad_max_uses", "max_uses must be an integer 1..100");
    }
    max_uses = Math.floor(n);
  }
  let expires_in_seconds: number | null | undefined = undefined;
  if (body?.expires_in_seconds != null) {
    const n = Number(body.expires_in_seconds);
    if (!Number.isFinite(n) || n < 0 || n > 90 * 24 * 3600) {
      return err(400, "bad_expiry", "expires_in_seconds must be 0..7776000 (90 days)");
    }
    expires_in_seconds = Math.floor(n);
  }
  const created_by_key_id = (gate as any).key?.id || "anon";
  const inv = await createInvite({ label, scopes, max_uses, expires_in_seconds, created_by_key_id });
  await recordSafe({
    kind: "invite.created",
    title: `Invite created · ${inv.label}`,
    body: `Scopes: ${inv.scopes.join(", ")}. ${inv.max_uses} seat${inv.max_uses === 1 ? "" : "s"}.`,
    href: "/settings/invites",
  });
  return NextResponse.json(publicView(inv));
}
