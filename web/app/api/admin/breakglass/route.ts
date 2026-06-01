// Break-glass emergency access admin API.
//
// GET    /api/admin/breakglass        -> active grant + recent history
// POST   /api/admin/breakglass        -> issue a new grant (mandatory reason, TTL)
// DELETE /api/admin/breakglass        -> revoke the active grant immediately
//
// Auth: admin scope, MFA enforced on mutations (same gate as the rest
// of /api/admin/*). Every call writes to the tamper-evident audit chain
// with the before/after grant snapshot so a SOC2 reviewer can verify
// exactly who used the break-glass, when, and why.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getState,
  grant,
  revoke,
  describeRemaining,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_REASON_LEN,
  MAX_REASON_LEN,
  type BreakGlassGrant,
} from "@/lib/breakGlassStore";

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
    const mfaDenied = await enforceAdminMfa(req, k, route, method);
    if (mfaDenied) return { denied: mfaDenied, key: k };
  }
  return { denied: null, key: k };
}

function shapeGrant(g: BreakGlassGrant) {
  const r = describeRemaining(g);
  return {
    id: g.id,
    granted_at: g.granted_at,
    expires_at: g.expires_at,
    granted_by: g.granted_by,
    reason: g.reason,
    ttl_seconds: g.ttl_seconds,
    uses: g.uses,
    last_used_at: g.last_used_at,
    revoked_at: g.revoked_at,
    revoked_by: g.revoked_by,
    expired: r.expired,
    seconds_remaining: r.seconds_remaining,
  };
}

function shapeState(state: { active: BreakGlassGrant | null; history: BreakGlassGrant[] }) {
  return {
    active: state.active ? shapeGrant(state.active) : null,
    history: state.history.map(shapeGrant),
    limits: {
      min_reason_len: MIN_REASON_LEN,
      max_reason_len: MAX_REASON_LEN,
      default_ttl_seconds: DEFAULT_TTL_SECONDS,
      max_ttl_seconds: MAX_TTL_SECONDS,
    },
  };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/breakglass";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const state = await getState();
  // If the persisted active row is past expiry, surface that to the UI
  // as null (the bypass check in v1Guard already treats it as expired).
  const live =
    state.active && !shapeGrant(state.active).expired ? state.active : null;
  await recordAuditEvent({
    req,
    route,
    method: "GET",
    status: 200,
    key: key ?? null,
    details: { active_grant: live?.id ?? null },
  });
  return NextResponse.json(shapeState(state));
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/breakglass";
  const { denied, key } = await requireAdmin(req, route, "POST");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({
      req, route, method: "POST", status: 400, key: key ?? null, reason: "bad_json",
    });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    await recordAuditEvent({
      req, route, method: "POST", status: 400, key: key ?? null, reason: "bad_body",
    });
    return err(400, "bad_body", "expected { reason: string, ttl_seconds?: number }");
  }
  const actor = key?.label ?? null;
  const result = await grant({
    reason: typeof body.reason === "string" ? body.reason : "",
    ttl_seconds: typeof body.ttl_seconds === "number" ? body.ttl_seconds : undefined,
    actor,
  });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method: "POST",
      status: 400,
      key: key ?? null,
      reason: result.code,
      details: { message: result.message },
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route,
    method: "POST",
    status: 200,
    key: key ?? null,
    reason: "break_glass_granted",
    details: {
      grant_id: result.grant.id,
      expires_at: result.grant.expires_at,
      ttl_seconds: result.grant.ttl_seconds,
      reason: result.grant.reason,
      superseded_id: result.superseded?.id ?? null,
    },
  });
  return NextResponse.json({ grant: shapeGrant(result.grant), superseded: result.superseded ? shapeGrant(result.superseded) : null });
}

export async function DELETE(req: NextRequest) {
  const route = "/api/admin/breakglass";
  const { denied, key } = await requireAdmin(req, route, "DELETE");
  if (denied) return denied;
  const actor = key?.label ?? null;
  const result = await revoke(actor);
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route,
      method: "DELETE",
      status: 404,
      key: key ?? null,
      reason: result.code,
    });
    return err(404, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route,
    method: "DELETE",
    status: 200,
    key: key ?? null,
    reason: "break_glass_revoked",
    details: {
      grant_id: result.revoked.id,
      used_count: result.revoked.uses,
      reason: result.revoked.reason,
    },
  });
  return NextResponse.json({ revoked: shapeGrant(result.revoked) });
}
