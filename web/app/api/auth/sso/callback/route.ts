// GET /api/auth/sso/callback?code=...&state=...
//
// IdP redirects the browser here. We:
//   1. Read + verify the HMAC-signed transaction cookie.
//   2. Confirm `state` from the query matches the cookie (CSRF defense).
//   3. Exchange `code` for tokens at the IdP token endpoint with PKCE.
//   4. Verify the ID token signature against the IdP JWKS, plus iss/aud/exp/nonce.
//   5. Enforce email_verified + workspace email-domain allowlist.
//   6. Mint the SSO session cookie and 302 to the requested return path.
//
// Every branch writes an audit-log line so an operator can reconstruct
// failed sign-ins (suspicious state mismatch, replayed nonce, expired
// token) without enabling debug logging.
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/auditStore";
import { getSsoPolicy, fetchDiscovery } from "@/lib/ssoPolicyStore";
import {
  verifyTxCookie,
  verifyIdToken,
  mintSession,
  SSO_COOKIE_NAME,
  SSO_TX_COOKIE_NAME,
  SESSION_TTL_S,
  cookieAttrs,
  clearCookie,
  isHttps,
} from "@/lib/ssoSession";
import { registerSession } from "@/lib/ssoSessionRegistry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/auth/sso/callback";

function fail(req: NextRequest, status: number, code: string, message: string) {
  const url = new URL(req.url);
  const target = new URL(`${url.origin}/settings/sso?error=${encodeURIComponent(code)}`);
  const res = NextResponse.redirect(target.toString(), 302);
  // Always clear the tx cookie on terminal outcomes.
  res.headers.append("Set-Cookie", clearCookie(SSO_TX_COOKIE_NAME, isHttps(req)));
  // For programmatic callers (tests) we also expose the JSON body via headers.
  res.headers.set("x-sso-error", code);
  return res;
}

function readCookie(req: NextRequest, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateQ = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  if (errParam) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: `idp-error:${errParam}` });
    return fail(req, 400, "idp_error", errParam);
  }
  if (!code || !stateQ) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: "missing-code-or-state" });
    return fail(req, 400, "missing_params", "missing code/state");
  }

  const txTok = readCookie(req, SSO_TX_COOKIE_NAME);
  const tx = await verifyTxCookie(txTok);
  if (!tx) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: "tx-invalid" });
    return fail(req, 400, "tx_invalid", "login session expired");
  }
  if (tx.state !== stateQ) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: "state-mismatch" });
    return fail(req, 400, "state_mismatch", "state mismatch");
  }

  const policy = await getSsoPolicy();
  if (!policy.enabled || !policy.client_id || !policy.client_secret || !policy.issuer) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 400, reason: "sso-disabled" });
    return fail(req, 400, "sso_disabled", "SSO not configured");
  }

  let disco;
  try { disco = await fetchDiscovery(policy.issuer); }
  catch (e: any) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 502, reason: `discovery:${e?.message}` });
    return fail(req, 502, "discovery_failed", "discovery unavailable");
  }

  const redirectUri = policy.redirect_uri || `${url.origin}/api/auth/sso/callback`;

  // Exchange code -> tokens.
  let tokenJson: any;
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: policy.client_id,
      client_secret: policy.client_secret,
      code_verifier: tx.verifier,
    });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let r: Response;
    try {
      r = await fetch(disco.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "accept": "application/json",
        },
        body: body.toString(),
        signal: ctrl.signal,
        redirect: "error",
      });
    } finally { clearTimeout(t); }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 502, reason: `token-exchange:${r.status}` });
      return fail(req, 502, "token_exchange_failed", `token endpoint ${r.status}: ${text.slice(0, 120)}`);
    }
    tokenJson = await r.json();
  } catch (e: any) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 502, reason: `token-exchange:${e?.message}` });
    return fail(req, 502, "token_exchange_failed", e?.message || "token exchange failed");
  }

  const idToken = tokenJson?.id_token;
  if (typeof idToken !== "string" || !idToken) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 502, reason: "no-id-token" });
    return fail(req, 502, "no_id_token", "IdP returned no id_token");
  }

  let claims;
  try {
    claims = await verifyIdToken(idToken, {
      issuer: policy.issuer,
      audience: policy.client_id,
      nonce: tx.nonce,
      jwks_uri: disco.jwks_uri,
    });
  } catch (e: any) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 401, reason: `idtoken:${e?.message}` });
    return fail(req, 401, "id_token_invalid", e?.message || "id token invalid");
  }

  const email = String(claims.email || "").toLowerCase();
  if (!email) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 401, reason: "no-email" });
    return fail(req, 401, "no_email", "IdP did not return email");
  }
  if (claims.email_verified === false) {
    await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 401, reason: "email-unverified" });
    return fail(req, 401, "email_unverified", "IdP says email is unverified");
  }

  if (policy.allowed_domains.length > 0) {
    const dom = email.includes("@") ? email.split("@").pop()!.toLowerCase() : "";
    if (!policy.allowed_domains.includes(dom)) {
      await recordAuditEvent({ req, route: ROUTE, method: "GET", status: 403, reason: `domain-denied:${dom}` });
      return fail(req, 403, "domain_denied", `domain ${dom} not allowed`);
    }
  }

  const minted = await mintSession({
    sub: String(claims.sub),
    email,
    iss: policy.issuer,
  });
  // Record the session in the server-side registry so an admin can list
  // and revoke it. IP is hashed inside the store; raw IP never persisted.
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "";
  await registerSession({
    jti: minted.jti,
    sub: String(claims.sub),
    email,
    iss: policy.issuer,
    iat: minted.iat,
    exp: minted.exp,
    ip,
    user_agent: req.headers.get("user-agent") || "",
  });

  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 200,
    reason: `sso-login-success:${email}`,
    details: { jti: minted.jti },
  });

  const dest = new URL(tx.return_to.startsWith("/") ? `${url.origin}${tx.return_to}` : `${url.origin}/settings/sso`);
  const res = NextResponse.redirect(dest.toString(), 302);
  const secure = isHttps(req);
  res.headers.append("Set-Cookie", `${SSO_COOKIE_NAME}=${encodeURIComponent(minted.cookie)}; ${cookieAttrs({ maxAgeS: SESSION_TTL_S, secure })}`);
  res.headers.append("Set-Cookie", clearCookie(SSO_TX_COOKIE_NAME, secure));
  return res;
}
