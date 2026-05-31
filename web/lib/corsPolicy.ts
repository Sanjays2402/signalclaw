// CORS policy for SignalClaw's HTTP surface.
//
// Why this exists:
//   The `/api/v1/*` API is bearer-token authenticated, but enterprise buyers
//   still expect an explicit, env-driven origin allowlist before they will
//   point a first-party browser SDK at it. Wildcarding (`Access-Control-
//   Allow-Origin: *`) is a procurement red flag the moment credentials or
//   bearer tokens are in play. This module is the single source of truth
//   that the edge middleware and the admin readout consume.
//
// Configuration:
//   SIGNALCLAW_CORS_ORIGINS - comma-separated list of *exact* origins.
//     Examples:
//       SIGNALCLAW_CORS_ORIGINS=https://app.example.com,https://admin.example.com
//   Unset or empty + production posture (SIGNALCLAW_ADMIN_KEY set) =>
//     no browser origins are permitted (server-to-server only).
//   Unset or empty + local single-user mode (SIGNALCLAW_ADMIN_KEY unset) =>
//     http://localhost:* and http://127.0.0.1:* are permitted so a local
//     dashboard or notebook works out of the box.
//
// We never echo `*` for credentialed responses, never reflect arbitrary
// origins, and never accept partial / suffix / regex matches. Either the
// caller's `Origin` header is byte-for-byte in the allowlist, or it gets
// no `Access-Control-Allow-Origin` header at all.

export type CorsDecision = {
  // The exact origin to echo back, or null to omit the header entirely.
  allowOrigin: string | null;
  // Always one of the three (loopback wildcard, explicit allowlist, denied).
  reason: "loopback-default" | "allowlist" | "denied" | "no-origin";
};

export type CorsPolicy = {
  // True when production posture is on (SIGNALCLAW_ADMIN_KEY is set).
  production: boolean;
  // Concrete origins from the env (deduped, trimmed, validated).
  origins: string[];
  // True when no explicit allowlist + local mode => loopback origins admitted.
  loopback_default: boolean;
};

// Allow `http://localhost:<port>` and `http://127.0.0.1:<port>`, with or
// without an explicit port. Strict: only loopback hosts, only http (TLS to
// localhost is not a thing operators ever configure).
const LOOPBACK_RE =
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i;

// RFC 6454 origins are scheme://host[:port] with no path. We're stricter:
// only http/https, host is a label or IPv4 literal, optional port.
const ORIGIN_RE =
  /^(https?):\/\/(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.\-]+)(?::\d{1,5})?$/;

export function parseOriginList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    if (s.length > 253) continue; // sanity
    if (!ORIGIN_RE.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function getPolicy(env: NodeJS.ProcessEnv = process.env): CorsPolicy {
  const production = Boolean(env.SIGNALCLAW_ADMIN_KEY);
  const origins = parseOriginList(env.SIGNALCLAW_CORS_ORIGINS);
  const loopback_default = !production && origins.length === 0;
  return { production, origins, loopback_default };
}

export function decide(
  origin: string | null,
  policy: CorsPolicy,
): CorsDecision {
  if (!origin) return { allowOrigin: null, reason: "no-origin" };
  const o = origin.trim();
  if (!o) return { allowOrigin: null, reason: "no-origin" };
  if (o.length > 253) return { allowOrigin: null, reason: "denied" };
  if (!ORIGIN_RE.test(o)) return { allowOrigin: null, reason: "denied" };
  if (policy.origins.includes(o)) {
    return { allowOrigin: o, reason: "allowlist" };
  }
  if (policy.loopback_default && LOOPBACK_RE.test(o)) {
    return { allowOrigin: o, reason: "loopback-default" };
  }
  return { allowOrigin: null, reason: "denied" };
}

// Headers we permit on cross-origin requests. Mirror everything route handlers
// actually consume (Authorization for bearer, x-mfa-* for MFA challenges,
// x-request-id for trace propagation, content-type for JSON bodies).
export const ALLOW_HEADERS =
  "Authorization, Content-Type, X-Request-Id, X-Correlation-Id, " +
  "X-MFA-Code, X-MFA-Recovery-Code, Idempotency-Key";

export const ALLOW_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

// Surface to the browser anything an SDK might want to read.
export const EXPOSE_HEADERS =
  "X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, " +
  "X-RateLimit-Reset, Retry-After";

// Preflight cache: ten minutes is the de-facto cap most browsers honour,
// long enough to avoid OPTIONS storms, short enough to roll allowlist changes.
export const MAX_AGE = "600";

// Apply CORS headers to a response. Caller decides whether this is a
// preflight (OPTIONS) or a real response; we set the same Vary/credentials/
// expose-headers either way so caches stay correct.
export function applyCors(
  resHeaders: Headers,
  decision: CorsDecision,
  isPreflight: boolean,
): void {
  // Always Vary on Origin so a shared cache never serves the wrong ACAO.
  // Append to any existing Vary rather than overwriting.
  const existingVary = resHeaders.get("Vary");
  const varyParts = new Set(
    (existingVary || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  varyParts.add("Origin");
  if (isPreflight) {
    varyParts.add("Access-Control-Request-Method");
    varyParts.add("Access-Control-Request-Headers");
  }
  resHeaders.set("Vary", Array.from(varyParts).join(", "));

  if (decision.allowOrigin) {
    resHeaders.set("Access-Control-Allow-Origin", decision.allowOrigin);
    resHeaders.set("Access-Control-Allow-Credentials", "true");
    resHeaders.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    if (isPreflight) {
      resHeaders.set("Access-Control-Allow-Methods", ALLOW_METHODS);
      resHeaders.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
      resHeaders.set("Access-Control-Max-Age", MAX_AGE);
    }
  }
}
