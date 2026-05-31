// Workspace-level CSP admin API.
//
//   GET  /api/admin/csp  -> { policy, effective, max_hosts }
//   PUT  /api/admin/csp  -> replace { mode, extra_hosts, reporting_enabled }
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set); admin MFA on
// every non-GET. Matches the rest of /api/admin/*.
//
// The middleware that actually emits the CSP header is edge-runtime and
// cannot read the persisted policy file. So this route returns both the
// persisted policy (what an operator clicked Save on) and the
// "effective" policy derived from env vars. The UI surfaces a banner
// when the two diverge so nobody believes a Save took effect when it
// did not.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getCspPolicy,
  updateCspPolicy,
  buildCspHeader,
  cspHeaderName,
  MAX_HOSTS,
  type CspMode,
  type CspPolicy,
} from "@/lib/cspPolicyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  route: string,
  method: string,
): Promise<{ denied: NextResponse | null; key: any }> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method, status: 200, key: k, reason: "local-mode" });
    return { denied: null, key: k };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), key: k };
  }
  if (method !== "GET") {
    const denied = await enforceAdminMfa(req, k, route, method);
    if (denied) return { denied, key: k };
  }
  return { denied: null, key: k };
}

function effectiveFromEnv(): {
  mode: CspMode;
  header_name: string | null;
  header_value: string | null;
  extra_hosts_env: string;
  source: "env";
} {
  const rawMode = (process.env.SIGNALCLAW_CSP_MODE || "").toLowerCase();
  const mode: CspMode =
    rawMode === "enforce"
      ? "enforce"
      : rawMode === "report" || rawMode === "report-only"
        ? "report"
        : "off";
  const reportOff = process.env.SIGNALCLAW_CSP_REPORT_DISABLED === "1";
  const policy: CspPolicy = {
    mode,
    extra_hosts: (process.env.SIGNALCLAW_CSP_EXTRA_HOSTS || "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    reporting_enabled: !reportOff,
    updated_at: null,
    updated_by: null,
  };
  const name = cspHeaderName(policy);
  return {
    mode,
    header_name: name,
    header_value: name ? buildCspHeader(policy) : null,
    extra_hosts_env: process.env.SIGNALCLAW_CSP_EXTRA_HOSTS || "",
    source: "env",
  };
}

function withMeta(p: CspPolicy) {
  const effective = effectiveFromEnv();
  const drift =
    p.mode !== effective.mode ||
    p.extra_hosts.join(",").toLowerCase() !==
      effective.extra_hosts_env
        .split(/[\s,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .join(",");
  return {
    policy: p,
    effective,
    max_hosts: MAX_HOSTS,
    drift,
  };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/csp";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const policy = await getCspPolicy();
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json(withMeta(policy));
}

export async function PUT(req: NextRequest) {
  const route = "/api/admin/csp";
  const { denied, key } = await requireAdmin(req, route, "PUT");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_json" });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_body" });
    return err(400, "bad_body", "body must be an object");
  }
  const mode = body.mode;
  if (mode !== "off" && mode !== "report" && mode !== "enforce") {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_mode" });
    return err(400, "bad_mode", "mode must be off|report|enforce");
  }
  const extra_hosts = Array.isArray(body.extra_hosts) ? body.extra_hosts : [];
  const reporting_enabled = body.reporting_enabled !== false;
  const result = await updateCspPolicy({
    mode,
    extra_hosts,
    reporting_enabled,
    actor: key?.id ?? null,
  });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method: "PUT",
      status: 400,
      key: key ?? null,
      reason: result.code,
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: key ?? null,
    details: {
      mode: result.policy.mode,
      hosts: result.policy.extra_hosts.length,
      reporting: result.policy.reporting_enabled,
      prev_mode: result.before.mode,
    },
  });
  return NextResponse.json(withMeta(result.policy));
}
