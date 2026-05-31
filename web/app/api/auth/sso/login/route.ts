// GET /api/auth/sso/login  -> 302 to IdP authorize endpoint
//
// Initiates an OIDC Authorization Code + PKCE flow. The PKCE verifier,
// state, nonce, and return_to URL are stashed in a short-lived HMAC-signed
// transaction cookie so /callback can verify them without a server-side
// session store.
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/auditStore";
import { getSsoPolicy, fetchDiscovery } from "@/lib/ssoPolicyStore";
import {
  generatePkce,
  randomToken,
  mintTxCookie,
  SSO_TX_COOKIE_NAME,
  TX_TTL_S,
  cookieAttrs,
  isHttps,
} from "@/lib/ssoSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/auth/sso/login";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function sameOriginReturn(req: NextRequest, raw: string | null): string {
  const fallback = "/settings/sso";
  if (!raw) return fallback;
  // Only allow relative same-origin paths to avoid open-redirects.
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (raw.length > 256) return fallback;
  return raw;
}

export async function GET(req: NextRequest) {
  const policy = await getSsoPolicy();
  if (!policy.enabled) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: "sso-disabled" });
    return err(400, "sso_disabled", "SSO is not configured");
  }

  let disco;
  try { disco = await fetchDiscovery(policy.issuer); }
  catch (e: any) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 502, reason: `discovery:${e?.message}` });
    return err(502, "discovery_failed", "OIDC discovery unavailable");
  }

  const url = new URL(req.url);
  const return_to = sameOriginReturn(req, url.searchParams.get("return_to"));
  const pkce = generatePkce();
  const state = randomToken(24);
  const nonce = randomToken(24);

  const redirectUri = policy.redirect_uri || `${url.origin}/api/auth/sso/callback`;

  const tx = await mintTxCookie({ state, nonce, verifier: pkce.verifier, return_to });

  const authorize = new URL(disco.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", policy.client_id);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", pkce.challenge);
  authorize.searchParams.set("code_challenge_method", pkce.method);

  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 302, reason: "sso-login-initiated",
  });
  const res = NextResponse.redirect(authorize.toString(), 302);
  res.headers.append(
    "Set-Cookie",
    `${SSO_TX_COOKIE_NAME}=${encodeURIComponent(tx)}; ${cookieAttrs({ maxAgeS: TX_TTL_S, secure: isHttps(req) })}`,
  );
  return res;
}
