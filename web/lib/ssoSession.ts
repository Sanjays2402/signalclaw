// SSO session cookie + OIDC ID-token verification.
//
// The session cookie (`sc_sso`) is an HMAC-SHA256-signed token that carries
// the IdP subject, email, issuer, issued-at, and expiry. It is verified on
// every admin guard call. The signing key is `SIGNALCLAW_SSO_SESSION_KEY`
// (or a stable per-install fallback derived from `.data/sso-session-key`)
// so cookies survive process restarts but cannot be forged by a third party.
//
// The ID-token verifier is a from-scratch RS256/ES256 check against the IdP
// JWKS — no third-party JWT dependency is added. It enforces:
//   * header.alg in {RS256, ES256}
//   * header.kid resolves to a JWK in JWKS
//   * signature valid via Web Crypto (subtle)
//   * payload.iss === expected issuer
//   * payload.aud includes expected client_id
//   * payload.exp in the future (with 60s skew)
//   * payload.nbf, payload.iat respected
//   * payload.nonce matches what login planted
//
// Caller is responsible for the email_verified + domain allowlist policy.
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fetchJwks } from "./ssoPolicyStore.ts";
import { checkSession as registryCheckSession, registerSession } from "./ssoSessionRegistry.ts";

const DATA_DIR = path.join(process.cwd(), ".data");
const KEY_FILE = path.join(DATA_DIR, "sso-session-key");
const COOKIE_NAME = "sc_sso";
const TX_COOKIE_NAME = "sc_sso_tx";
export const SSO_COOKIE_NAME = COOKIE_NAME;
export const SSO_TX_COOKIE_NAME = TX_COOKIE_NAME;
export const SESSION_TTL_S = 12 * 60 * 60; // 12h
export const TX_TTL_S = 10 * 60; // 10 minutes to complete login

let cachedKey: Buffer | null = null;

async function getSigningKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const env = process.env.SIGNALCLAW_SSO_SESSION_KEY;
  if (env && env.length >= 32) {
    cachedKey = Buffer.from(env, "utf-8");
    return cachedKey;
  }
  try {
    const raw = await fs.readFile(KEY_FILE, "utf-8");
    if (raw && raw.length >= 32) {
      cachedKey = Buffer.from(raw, "utf-8");
      return cachedKey;
    }
  } catch {}
  const gen = crypto.randomBytes(48).toString("base64url");
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KEY_FILE, gen, { mode: 0o600 });
  cachedKey = Buffer.from(gen, "utf-8");
  return cachedKey;
}

function b64u(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return b.toString("base64url");
}
function b64uDec(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export type SsoSession = {
  v: 1;
  sub: string;
  email: string;
  iss: string;
  iat: number;
  exp: number;
  // jti is the server-side session registry id. Older cookies minted
  // before the registry shipped do not carry one; those sessions are
  // rejected by `verifySessionCookie` because they cannot be revoked.
  jti?: string;
};

export type MintInput = Omit<SsoSession, "v" | "iat" | "exp"> & { jti?: string };
export type MintResult = { cookie: string; jti: string; iat: number; exp: number };

export async function mintSessionCookie(s: MintInput): Promise<string> {
  const r = await mintSession(s);
  // Auto-register so single-arg callers (and existing tests) still get a
  // verifiable cookie. Callers that need to attach IP / user-agent should
  // use `mintSession` + `registerSession` directly.
  await registerSession({
    jti: r.jti,
    sub: s.sub,
    email: s.email,
    iss: s.iss,
    iat: r.iat,
    exp: r.exp,
    ip: null,
    user_agent: null,
  });
  return r.cookie;
}

export async function mintSession(s: MintInput): Promise<MintResult> {
  const now = Math.floor(Date.now() / 1000);
  const jti = s.jti && typeof s.jti === "string" && s.jti.length >= 8
    ? s.jti
    : crypto.randomBytes(18).toString("base64url");
  const payload: SsoSession = {
    v: 1,
    iat: now,
    exp: now + SESSION_TTL_S,
    sub: s.sub,
    email: s.email,
    iss: s.iss,
    jti,
  };
  const body = b64u(JSON.stringify(payload));
  const key = await getSigningKey();
  const sig = crypto.createHmac("sha256", key).update(body).digest();
  return { cookie: `${body}.${b64u(sig)}`, jti, iat: payload.iat, exp: payload.exp };
}

export type VerifySessionOptions = {
  // When true, skip the server-side revocation registry check. Used by
  // logout-style handlers that want to read the email from an already-
  // revoked cookie. Defaults to false so every guarded path consults
  // the registry.
  skipRegistry?: boolean;
  // When supplied, the registry updates `last_seen_at` (throttled to
  // 30s) on a successful verification. Pass the caller IP so the row's
  // last-seen IP hash also moves. Pass `null` to skip the update.
  liveness?: { ip?: string | null } | null;
};

export async function verifySessionCookie(
  token: string | null | undefined,
  opts: VerifySessionOptions = {},
): Promise<SsoSession | null> {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const key = await getSigningKey();
  const expected = crypto.createHmac("sha256", key).update(body).digest();
  let given: Buffer;
  try { given = b64uDec(sig); } catch { return null; }
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;
  let parsed: SsoSession;
  try { parsed = JSON.parse(b64uDec(body).toString("utf-8")) as SsoSession; }
  catch { return null; }
  if (!parsed || parsed.v !== 1) return null;
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp <= now) return null;
  if (typeof parsed.sub !== "string" || typeof parsed.email !== "string" || typeof parsed.iss !== "string") return null;
  if (!opts.skipRegistry) {
    const status = await registryCheckSession(parsed.jti, parsed.iat, parsed.exp, opts.liveness ?? undefined);
    if (status.revoked) return null;
  }
  return parsed;
}

// Transaction cookie carries the PKCE verifier + nonce + state + return path
// between /login and /callback. Also HMAC-signed so a victim cannot have a
// forged state shoved at them.
export type SsoTx = {
  v: 1;
  state: string;
  nonce: string;
  verifier: string;
  return_to: string;
  iat: number;
};

export async function mintTxCookie(tx: Omit<SsoTx, "v" | "iat">): Promise<string> {
  const payload: SsoTx = { v: 1, iat: Math.floor(Date.now() / 1000), ...tx };
  const body = b64u(JSON.stringify(payload));
  const key = await getSigningKey();
  const sig = crypto.createHmac("sha256", key).update("tx:" + body).digest();
  return `${body}.${b64u(sig)}`;
}

export async function verifyTxCookie(token: string | null | undefined): Promise<SsoTx | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const key = await getSigningKey();
  const expected = crypto.createHmac("sha256", key).update("tx:" + body).digest();
  let given: Buffer;
  try { given = b64uDec(sig); } catch { return null; }
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;
  let parsed: SsoTx;
  try { parsed = JSON.parse(b64uDec(body).toString("utf-8")) as SsoTx; }
  catch { return null; }
  if (!parsed || parsed.v !== 1) return null;
  const now = Math.floor(Date.now() / 1000);
  if (now - parsed.iat > TX_TTL_S) return null;
  return parsed;
}

// ---- PKCE -------------------------------------------------------------------

export function generatePkce(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// ---- ID token verification --------------------------------------------------

type Jwk = {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string; e?: string;        // RSA
  crv?: string; x?: string; y?: string; // EC
};

export type IdTokenClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string; // Google: hosted domain
  [k: string]: unknown;
};

export type VerifyOptions = {
  issuer: string;
  audience: string;
  nonce: string;
  jwks_uri: string;
  clockSkewS?: number;
  // Test seam: allow injecting a JWKS without network.
  jwksOverride?: { keys: Jwk[] };
};

export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<IdTokenClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const [h64, p64, s64] = parts;
  let header: { alg?: string; kid?: string; typ?: string };
  let payload: IdTokenClaims;
  try { header = JSON.parse(b64uDec(h64).toString("utf-8")); }
  catch { throw new Error("bad jwt header"); }
  try { payload = JSON.parse(b64uDec(p64).toString("utf-8")) as IdTokenClaims; }
  catch { throw new Error("bad jwt payload"); }

  if (header.alg !== "RS256" && header.alg !== "ES256") {
    throw new Error(`unsupported alg: ${header.alg}`);
  }

  const jwks = opts.jwksOverride
    ? opts.jwksOverride
    : (await fetchJwks(opts.jwks_uri)) as { keys: Jwk[] };
  let key: Jwk | undefined =
    jwks.keys.find((k) => (k as Jwk).kid === header.kid) as Jwk | undefined;
  if (!key && jwks.keys.length === 1) key = jwks.keys[0] as Jwk;
  if (!key) {
    // refresh once on miss
    const refreshed = (await fetchJwks(opts.jwks_uri, { force: true })) as { keys: Jwk[] };
    key = refreshed.keys.find((k) => (k as Jwk).kid === header.kid) as Jwk | undefined;
  }
  if (!key) throw new Error("jwt kid not found in jwks");

  const data = Buffer.from(`${h64}.${p64}`, "utf-8");
  const sig = b64uDec(s64);
  const algoName = header.alg === "RS256" ? "RSASSA-PKCS1-v1_5" : "ECDSA";
  const importAlgo: any = header.alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "ECDSA", namedCurve: "P-256" };
  const verifyAlgo: any = header.alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5" }
    : { name: "ECDSA", hash: "SHA-256" };

  const cryptoKey = await (crypto as any).webcrypto.subtle.importKey(
    "jwk",
    key as any,
    importAlgo,
    false,
    ["verify"],
  );
  const ok = await (crypto as any).webcrypto.subtle.verify(
    verifyAlgo,
    cryptoKey,
    sig,
    data,
  );
  if (!ok) throw new Error("jwt signature invalid");

  const skew = opts.clockSkewS ?? 60;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + skew < now) {
    throw new Error("jwt expired");
  }
  if (typeof payload.nbf === "number" && payload.nbf - skew > now) {
    throw new Error("jwt not yet valid");
  }
  if (typeof payload.iat === "number" && payload.iat - skew > now) {
    throw new Error("jwt iat in future");
  }
  if (payload.iss !== opts.issuer) throw new Error("jwt issuer mismatch");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(opts.audience)) throw new Error("jwt audience mismatch");
  if (payload.nonce !== opts.nonce) throw new Error("jwt nonce mismatch");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("jwt sub missing");

  return payload;
}

export function cookieAttrs(opts: { maxAgeS: number; secure: boolean }): string {
  const a = [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAgeS}`,
  ];
  if (opts.secure) a.push("Secure");
  return a.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  const a = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) a.push("Secure");
  return `${name}=; ${a.join("; ")}`;
}

export function isHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto") || "";
  if (proto.toLowerCase() === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch { return false; }
}
