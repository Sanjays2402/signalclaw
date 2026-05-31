import { NextRequest, NextResponse } from "next/server";
import { consumeInvite, getInvite, statusOf } from "@/lib/inviteStore";
import { createKey, publicView, revokeKey } from "@/lib/keyStore";
import { ensureSeatAvailable } from "@/lib/seats";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return (req as any).ip || "";
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const route = `/api/invites/${token}/accept`;

  const inv = await getInvite(token);
  if (!inv) {
    await recordAuditEvent({ req, route, method: "POST", status: 404, key: null, reason: "invite_not_found" });
    return err(404, "not_found", "invite not found");
  }
  const status = statusOf(inv);
  if (status !== "pending") {
    await recordAuditEvent({ req, route, method: "POST", status: 410, key: null, reason: `invite_${status}` });
    return err(410, `invite_${status}`, `invite is ${status}`);
  }
  try {
    await ensureSeatAvailable();
  } catch (e: any) {
    await recordAuditEvent({ req, route, method: "POST", status: 409, key: null, reason: "seat_limit" });
    return err(e.status || 409, e.code || "seat_limit", e.message || "no seats available");
  }
  let labelOverride: string | undefined;
  try {
    const b = await req.json().catch(() => null);
    if (b && typeof b.label === "string" && b.label.trim()) {
      labelOverride = b.label.trim().slice(0, 80);
    }
  } catch {
    // body optional
  }
  const { key, secret } = await createKey({
    label: labelOverride || inv.label,
    scopes: inv.scopes,
  });
  const consumed = await consumeInvite(token, key.id, clientIp(req));
  if (!consumed) {
    // Race loss: roll back the just-minted key so we never leave an
    // orphaned credential behind.
    await revokeKey(key.id);
    await recordAuditEvent({ req, route, method: "POST", status: 410, key: null, reason: "invite_race_lost" });
    return err(410, "invite_exhausted", "invite was redeemed by another user");
  }
  await recordSafe({
    kind: "invite.accepted",
    title: `Invite redeemed · ${key.label}`,
    body: `New key prefix ${key.prefix}…`,
    href: "/settings/keys",
  });
  await recordAuditEvent({ req, route, method: "POST", status: 200, key: null, reason: "invite_redeemed" });
  return NextResponse.json({ ...publicView(key), secret });
}
