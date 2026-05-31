// Per-source-IP failed-authentication lockout admin API.
//
// GET    /api/admin/auth-lockout            -> { config, entries }
// PUT    /api/admin/auth-lockout            -> update config (threshold,
//                                              window_seconds, cooldown_seconds, enabled)
// DELETE /api/admin/auth-lockout?ip=1.2.3.4 -> manually unlock one IP
//
// Mirrors the admin gate used by every other /api/admin/* surface so a
// procurement reviewer drives this with the same credential they use for
// every other workspace setting. Every mutation lands in the tamper-evident
// audit chain with a before/after diff (config) or the unlocked IP.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getConfig,
  setConfig,
  listLockouts,
  unlockIp,
  DEFAULT_CONFIG,
  type LockoutConfig,
} from "@/lib/authLockoutStore";
import { normalizeIp } from "@/lib/ipMatch";

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
      req, route, method, status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), key: k };
  }
  return { denied: null, key: k };
}

function diffConfig(before: LockoutConfig, after: LockoutConfig) {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(after) as (keyof LockoutConfig)[]) {
    if (before[k] !== after[k]) out[k] = { before: before[k], after: after[k] };
  }
  return out;
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/auth-lockout";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const [config, entries] = await Promise.all([getConfig(), listLockouts()]);
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json({
    config,
    defaults: DEFAULT_CONFIG,
    entries,
    total: entries.length,
    locked_count: entries.filter((e) => e.locked).length,
  });
}

export async function PUT(req: NextRequest) {
  const route = "/api/admin/auth-lockout";
  const { denied, key } = await requireAdmin(req, route, "PUT");
  if (denied) return denied;
  let body: any;
  try { body = await req.json(); } catch {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_json" });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_body" });
    return err(400, "bad_body", "expected { threshold, window_seconds, cooldown_seconds, enabled }");
  }
  const before = await getConfig();
  const after = await setConfig({
    threshold: body.threshold ?? before.threshold,
    window_seconds: body.window_seconds ?? before.window_seconds,
    cooldown_seconds: body.cooldown_seconds ?? before.cooldown_seconds,
    enabled: typeof body.enabled === "boolean" ? body.enabled : before.enabled,
  });
  await recordAuditEvent({
    req, route, method: "PUT", status: 200, key: key ?? null,
    reason: "auth_lockout_config_updated",
    details: { diff: diffConfig(before, after), before, after },
  });
  return NextResponse.json({ config: after });
}

export async function DELETE(req: NextRequest) {
  const route = "/api/admin/auth-lockout";
  const { denied, key } = await requireAdmin(req, route, "DELETE");
  if (denied) return denied;
  const ipRaw = req.nextUrl.searchParams.get("ip") ?? "";
  const ip = normalizeIp(ipRaw);
  if (!ip) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 400, key: key ?? null, reason: "bad_ip" });
    return err(400, "bad_ip", "query parameter ?ip=<address> is required and must be a valid IPv4 or IPv6 address");
  }
  const found = await unlockIp(ip);
  if (!found) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 404, key: key ?? null, reason: "not_found", details: { ip } });
    return err(404, "not_found", `no lockout record for ${ip}`);
  }
  await recordAuditEvent({
    req, route, method: "DELETE", status: 200, key: key ?? null,
    reason: "auth_lockout_cleared",
    details: { ip },
  });
  return NextResponse.json({ ok: true, ip });
}
