// Workspace OIDC SSO policy.
//
// Procurement reality: every enterprise buyer above ~50 seats requires
// SSO against their IdP (Okta, Azure AD, Google Workspace). Without it
// the dashboard is single-key + admin MFA, which closes mid-market deals
// at best. This module is the persisted policy plus the helpers that
// validate an OpenID Connect provider via its Discovery document.
//
// Storage: <DATA_DIR>/sso-policy.json (atomic write via tmp+rename).
//
// What gets persisted:
//   * issuer            -> https://accounts.google.com (no trailing slash)
//   * client_id         -> public IdP client id
//   * client_secret     -> kept server-side; never returned in GET
//   * allowed_domains   -> email-domain allowlist (lowercased), [] = any
//   * enforce           -> when true, the dashboard refuses non-SSO admin
//                          sessions (admin-key still works for CI/cron via
//                          /api/admin/* but browser navigation must SSO)
//   * redirect_uri      -> optional override; otherwise computed from req
//   * updated_at/by     -> audit
//
// Discovery validation is best-effort and cached for 1h so a flaky IdP
// does not break login. The cache is per-issuer.
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "sso-policy.json");

export type SsoPolicy = {
  enabled: boolean;
  issuer: string;
  client_id: string;
  client_secret: string; // never returned by GET
  allowed_domains: string[];
  enforce: boolean;
  redirect_uri: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

export type SsoPolicyPublic = Omit<SsoPolicy, "client_secret"> & {
  client_secret_set: boolean;
};

const MAX_DOMAINS = 32;
const ISSUER_RE = /^https:\/\/[a-z0-9.\-]+(?::\d+)?(?:\/[A-Za-z0-9._~/\-]*)?$/i;
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export function defaultPolicy(): SsoPolicy {
  return {
    enabled: false,
    issuer: "",
    client_id: "",
    client_secret: "",
    allowed_domains: [],
    enforce: false,
    redirect_uri: null,
    updated_at: null,
    updated_by: null,
  };
}

export function toPublic(p: SsoPolicy): SsoPolicyPublic {
  const { client_secret, ...rest } = p;
  return { ...rest, client_secret_set: !!client_secret };
}

export async function getSsoPolicy(): Promise<SsoPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SsoPolicy>;
    return { ...defaultPolicy(), ...parsed };
  } catch {
    return defaultPolicy();
  }
}

export type UpdateInput = {
  enabled?: boolean;
  issuer?: string;
  client_id?: string;
  client_secret?: string | null; // null preserves existing
  allowed_domains?: string[];
  enforce?: boolean;
  redirect_uri?: string | null;
  actor?: string | null;
};

export function canonicalizeIssuer(raw: string): string {
  const s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) throw new Error("issuer required");
  if (s.length > 256) throw new Error("issuer too long");
  if (!ISSUER_RE.test(s)) throw new Error("issuer must be https URL");
  return s;
}

export function canonicalizeDomains(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const v = String(r || "").trim().toLowerCase();
    if (!v) continue;
    if (v.length > 253) throw new Error(`domain too long: ${v}`);
    if (!DOMAIN_RE.test(v)) throw new Error(`invalid domain: ${v}`);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length > MAX_DOMAINS) {
      throw new Error(`too many domains (max ${MAX_DOMAINS})`);
    }
  }
  return out;
}

export async function updateSsoPolicy(input: UpdateInput): Promise<{
  before: SsoPolicy;
  after: SsoPolicy;
}> {
  const before = await getSsoPolicy();
  const next: SsoPolicy = { ...before };

  if (typeof input.enabled === "boolean") next.enabled = input.enabled;
  if (typeof input.issuer === "string") next.issuer = canonicalizeIssuer(input.issuer);
  if (typeof input.client_id === "string") {
    const v = input.client_id.trim();
    if (!v) throw new Error("client_id required");
    if (v.length > 256) throw new Error("client_id too long");
    if (!/^[A-Za-z0-9._:\-]+$/.test(v)) throw new Error("invalid client_id");
    next.client_id = v;
  }
  if (input.client_secret === null) {
    // explicit clear
    next.client_secret = "";
  } else if (typeof input.client_secret === "string" && input.client_secret) {
    if (input.client_secret.length > 512) throw new Error("client_secret too long");
    next.client_secret = input.client_secret;
  }
  if (Array.isArray(input.allowed_domains)) {
    next.allowed_domains = canonicalizeDomains(input.allowed_domains);
  }
  if (typeof input.enforce === "boolean") next.enforce = input.enforce;
  if (input.redirect_uri === null) next.redirect_uri = null;
  else if (typeof input.redirect_uri === "string") {
    const v = input.redirect_uri.trim();
    if (v) {
      if (v.length > 512) throw new Error("redirect_uri too long");
      if (!/^https?:\/\//.test(v)) throw new Error("redirect_uri must be http(s)");
      next.redirect_uri = v;
    } else next.redirect_uri = null;
  }

  if (next.enabled) {
    if (!next.issuer || !next.client_id || !next.client_secret) {
      throw new Error("issuer, client_id, client_secret required when enabled");
    }
  }
  if (next.enforce && !next.enabled) {
    throw new Error("cannot enforce SSO while SSO is disabled");
  }

  next.updated_at = new Date().toISOString();
  next.updated_by = input.actor ?? next.updated_by;

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(tmp, POLICY_FILE);
  return { before, after: next };
}

// ---- OIDC Discovery + JWKS (cached) ----------------------------------------

export type DiscoveryDoc = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
};

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1h
const JWKS_TTL_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { at: number; doc: DiscoveryDoc }>();
const jwksCache = new Map<string, { at: number; jwks: { keys: unknown[] } }>();

export async function fetchDiscovery(issuer: string, opts?: { force?: boolean }): Promise<DiscoveryDoc> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const cached = discoveryCache.get(issuer);
  if (!opts?.force && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.doc;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`discovery ${res.status}`);
  const j = (await res.json()) as DiscoveryDoc;
  if (!j.issuer || j.issuer.replace(/\/+$/, "") !== issuer) {
    throw new Error("discovery issuer mismatch");
  }
  for (const f of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof j[f] !== "string" || !/^https:\/\//.test(j[f] as string)) {
      throw new Error(`discovery missing ${f}`);
    }
  }
  discoveryCache.set(issuer, { at: Date.now(), doc: j });
  return j;
}

export async function fetchJwks(jwks_uri: string, opts?: { force?: boolean }): Promise<{ keys: unknown[] }> {
  const cached = jwksCache.get(jwks_uri);
  if (!opts?.force && cached && Date.now() - cached.at < JWKS_TTL_MS) {
    return cached.jwks;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  let res: Response;
  try {
    res = await fetch(jwks_uri, { signal: ctrl.signal, redirect: "error" });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const j = (await res.json()) as { keys: unknown[] };
  if (!j || !Array.isArray(j.keys)) throw new Error("jwks malformed");
  jwksCache.set(jwks_uri, { at: Date.now(), jwks: j });
  return j;
}

// Exposed for tests.
export function __clearSsoCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
