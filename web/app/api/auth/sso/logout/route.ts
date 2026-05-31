// POST /api/auth/sso/logout  -> clears the SSO session cookie.
// Also supports GET so a plain <a> can sign out without JS.
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/auditStore";
import { SSO_COOKIE_NAME, SSO_TX_COOKIE_NAME, clearCookie, isHttps, verifySessionCookie } from "@/lib/ssoSession";
import { revokeBySession } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/auth/sso/logout";

async function handle(req: NextRequest) {
  const raw = req.headers.get("cookie") || "";
  let email = "";
  let jti: string | undefined;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === SSO_COOKIE_NAME) {
      const tok = decodeURIComponent(part.slice(eq + 1));
      // skipRegistry so a session that was already revoked elsewhere
      // still resolves to an email for the audit line.
      const s = await verifySessionCookie(tok, { skipRegistry: true });
      if (s) { email = s.email; jti = s.jti; }
    }
  }
  if (jti) {
    await revokeBySession(jti, { actor: email || "self", reason: "user-logout" });
  }
  await recordAuditEvent({
    req, route: ROUTE, method: req.method, status: 200,
    reason: email ? `sso-logout:${email}` : "sso-logout:no-session",
    details: jti ? { jti } : undefined,
  });
  const url = new URL(req.url);
  const res = req.method === "GET"
    ? NextResponse.redirect(`${url.origin}/settings/sso`, 302)
    : NextResponse.json({ ok: true });
  const secure = isHttps(req);
  res.headers.append("Set-Cookie", clearCookie(SSO_COOKIE_NAME, secure));
  res.headers.append("Set-Cookie", clearCookie(SSO_TX_COOKIE_NAME, secure));
  return res;
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
