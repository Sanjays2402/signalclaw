// Framework-free core for the admin gate. Keeps the actual policy
// (`SIGNALCLAW_ADMIN_KEY` opt-in, require admin scope when set) in one
// place so it can be unit-tested without booting Next, and so a non-Next
// caller (cron, internal scripts) could reuse the exact same check.
//
// Two authentication paths grant admin:
//   1. An API key with the `admin` scope (machine-to-machine, CI, cron).
//   2. A valid SSO session cookie minted by the OIDC callback, when the
//      caller's email matches the workspace SSO domain allowlist. This
//      is the path browser sessions use after Sign in with Okta /
//      Google / Azure AD.
//
// When `enforce` is on in the SSO policy, the API-key path is still
// honoured (CI must not break on a policy flip) but `decideAdmin`
// reports the session source so route handlers can refuse browser
// navigation that lacks SSO.
import { authenticate, extractKey, type StoredKey } from "./keyStore.ts";
import { verifySessionCookie, SSO_COOKIE_NAME, type SsoSession } from "./ssoSession.ts";
import { getSsoPolicy } from "./ssoPolicyStore.ts";

export type AdminDecision =
  | {
      allowed: true;
      key: StoredKey | null;
      mode: "local" | "admin" | "sso";
      reason: "local-mode" | "admin-key" | "sso-session";
      session?: SsoSession;
      enforce_sso?: boolean;
    }
  | {
      allowed: false;
      key: StoredKey | null;
      mode: "admin";
      reason: "forbidden:admin-required" | "forbidden:sso-required" | "forbidden:sso-domain";
      enforce_sso?: boolean;
    };

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

function emailDomain(email: string): string {
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase() : "";
}

export async function decideAdmin(req: Request): Promise<AdminDecision> {
  const k = await authenticate(extractKey(req));
  const policy = await getSsoPolicy();

  // SSO session path.
  const sessionTok = readCookie(req, SSO_COOKIE_NAME);
  let session: SsoSession | null = null;
  if (sessionTok) session = await verifySessionCookie(sessionTok);
  if (session && policy.enabled) {
    if (policy.allowed_domains.length > 0) {
      const dom = emailDomain(session.email);
      if (!policy.allowed_domains.includes(dom)) {
        return {
          allowed: false,
          key: k ?? null,
          mode: "admin",
          reason: "forbidden:sso-domain",
          enforce_sso: policy.enforce,
        };
      }
    }
    return {
      allowed: true,
      key: k,
      mode: "sso",
      reason: "sso-session",
      session,
      enforce_sso: policy.enforce,
    };
  }

  // No admin key configured -> local single-user mode (legacy behaviour).
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    if (policy.enforce && policy.enabled) {
      return {
        allowed: false,
        key: k ?? null,
        mode: "admin",
        reason: "forbidden:sso-required",
        enforce_sso: true,
      };
    }
    return { allowed: true, key: k, mode: "local", reason: "local-mode", enforce_sso: policy.enforce };
  }

  // Admin-key path. Allowed even when SSO is enforced — CI / cron need it.
  if (!k || !k.scopes.includes("admin")) {
    return { allowed: false, key: k ?? null, mode: "admin", reason: "forbidden:admin-required", enforce_sso: policy.enforce };
  }
  return { allowed: true, key: k, mode: "admin", reason: "admin-key", enforce_sso: policy.enforce };
}
