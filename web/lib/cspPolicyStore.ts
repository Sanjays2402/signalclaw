// Workspace-level Content Security Policy.
//
// Procurement reality: every enterprise security questionnaire asks
// whether the SaaS dashboard ships a Content-Security-Policy header.
// "X-Frame-Options" + "X-Content-Type-Options" cover a thin slice of
// browser threats; CSP is what blocks injected <script> from a stored
// XSS or a compromised CDN.
//
// This module is the policy + persistence. The actual header is written
// by `middleware.ts` on every dashboard response. Two modes are wired
// so a buyer can roll out CSP without a "white page on Monday" outage:
//
//   * "report-only" -> sends `Content-Security-Policy-Report-Only`,
//      the browser only complains via `report-uri` violations.
//   * "enforce"     -> sends `Content-Security-Policy`, the browser
//      blocks anything outside the policy.
//
// "off" turns CSP back off without touching env vars.
//
// Defaults are derived from `SIGNALCLAW_CSP_MODE` (off|report|enforce)
// and `SIGNALCLAW_CSP_EXTRA_HOSTS` (space-separated) so existing
// installs can opt in via env if they do not want to wire the admin
// route. Mutations from the admin route are audited by the caller.
//
// Storage: <DATA_DIR>/csp-policy.json (atomic write via tmp+rename).
import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), ".data");
const POLICY_FILE = path.join(DATA_DIR, "csp-policy.json");

export type CspMode = "off" | "report" | "enforce";

export type CspPolicy = {
  mode: CspMode;
  // Additional hosts a workspace trusts for `script-src`, `connect-src`,
  // `img-src`. Each entry is a CSP source expression (hostname, scheme,
  // or `'sha256-...'`). Validated by `canonicalizeHosts`.
  extra_hosts: string[];
  // When true, the middleware also emits `report-to` + `report-uri`
  // pointing at /api/csp-report so violations land in the audit log.
  reporting_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
};

export const MAX_HOSTS = 32;
export const MAX_HOST_LEN = 200;

// Conservative allowlist for source expressions:
//   * absolute scheme            https://example.com
//   * host only                  example.com
//   * wildcard subdomain         *.example.com
//   * inline keyword             'self' 'none' 'unsafe-inline' 'strict-dynamic'
//   * hash                       'sha256-...'  'sha384-...'  'sha512-...'
//   * data:                      data:
// Anything else is refused so an operator typo cannot ship an
// effectively-open policy.
const SRC_RE =
  /^(?:'(?:self|none|unsafe-inline|unsafe-eval|strict-dynamic|sha(?:256|384|512)-[A-Za-z0-9+/=]+)'|(?:data|https?|wss?):(?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/\-]*)?)?|(?:\*\.)?[a-z0-9.-]+(?::\d+)?)$/i;

function defaultEnvMode(): CspMode {
  const raw = (process.env.SIGNALCLAW_CSP_MODE || "").toLowerCase();
  if (raw === "enforce") return "enforce";
  if (raw === "report" || raw === "report-only") return "report";
  return "off";
}

function defaultEnvHosts(): string[] {
  const raw = process.env.SIGNALCLAW_CSP_EXTRA_HOSTS || "";
  if (!raw.trim()) return [];
  return canonicalizeHosts(raw.split(/[\s,]+/).filter(Boolean));
}

function defaultPolicy(): CspPolicy {
  return {
    mode: defaultEnvMode(),
    extra_hosts: defaultEnvHosts(),
    reporting_enabled: true,
    updated_at: null,
    updated_by: null,
  };
}

export function canonicalizeHosts(input: unknown): string[] {
  if (!Array.isArray(input)) {
    const e: any = new Error("extra_hosts must be an array of strings");
    e.code = "bad_type";
    throw e;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      const e: any = new Error("each host must be a string");
      e.code = "bad_type";
      throw e;
    }
    const v = raw.trim();
    if (!v) continue;
    if (v.length > MAX_HOST_LEN) {
      const e: any = new Error(`host too long: ${v.slice(0, 40)}...`);
      e.code = "bad_host";
      throw e;
    }
    if (!SRC_RE.test(v)) {
      const e: any = new Error(`invalid CSP source: ${v}`);
      e.code = "bad_host";
      throw e;
    }
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length > MAX_HOSTS) {
      const e: any = new Error(`too many hosts (max ${MAX_HOSTS})`);
      e.code = "too_many";
      throw e;
    }
  }
  return out;
}

export async function getCspPolicy(): Promise<CspPolicy> {
  try {
    const raw = await fs.readFile(POLICY_FILE, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return defaultPolicy();
    const mode: CspMode =
      j.mode === "enforce" || j.mode === "report" ? j.mode : "off";
    let extra: string[] = [];
    if (Array.isArray(j.extra_hosts)) {
      try {
        extra = canonicalizeHosts(j.extra_hosts);
      } catch {
        extra = [];
      }
    }
    return {
      mode,
      extra_hosts: extra,
      reporting_enabled: j.reporting_enabled !== false,
      updated_at: typeof j.updated_at === "string" ? j.updated_at : null,
      updated_by: typeof j.updated_by === "string" ? j.updated_by : null,
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return defaultPolicy();
    throw e;
  }
}

export type UpdateCspInput = {
  mode: CspMode;
  extra_hosts: string[];
  reporting_enabled: boolean;
  actor?: string | null;
};

export type UpdateCspResult =
  | { ok: true; policy: CspPolicy; before: CspPolicy }
  | {
      ok: false;
      code: "bad_mode" | "bad_type" | "bad_host" | "too_many";
      message: string;
    };

export async function updateCspPolicy(
  input: UpdateCspInput,
): Promise<UpdateCspResult> {
  if (
    input.mode !== "off" &&
    input.mode !== "report" &&
    input.mode !== "enforce"
  ) {
    return { ok: false, code: "bad_mode", message: "mode must be off|report|enforce" };
  }
  let canon: string[];
  try {
    canon = canonicalizeHosts(input.extra_hosts);
  } catch (e: any) {
    const code =
      e?.code === "bad_type" || e?.code === "bad_host" || e?.code === "too_many"
        ? e.code
        : "bad_host";
    return { ok: false, code, message: String(e?.message || e) };
  }
  const before = await getCspPolicy();
  const next: CspPolicy = {
    mode: input.mode,
    extra_hosts: canon,
    reporting_enabled: !!input.reporting_enabled,
    updated_at: new Date().toISOString(),
    updated_by: input.actor ?? null,
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = POLICY_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, POLICY_FILE);
  return { ok: true, policy: next, before };
}

// Build the actual header value. Pure function so middleware can call
// it with a snapshot loaded out-of-band. The base directives below are
// the tightest set the dashboard still loads under: `'self'` everywhere,
// inline styles allowed (Tailwind injects them), no inline script.
export function buildCspHeader(policy: CspPolicy): string {
  const extras = policy.extra_hosts.join(" ");
  const join = (base: string) => (extras ? `${base} ${extras}` : base);
  const parts = [
    "default-src 'self'",
    join("script-src 'self'"),
    "style-src 'self' 'unsafe-inline'",
    join("img-src 'self' data: blob:"),
    join("connect-src 'self'"),
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
  ];
  if (policy.reporting_enabled) {
    parts.push("report-uri /api/csp-report");
  }
  return parts.join("; ");
}

export function cspHeaderName(policy: CspPolicy): string | null {
  if (policy.mode === "off") return null;
  return policy.mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}
