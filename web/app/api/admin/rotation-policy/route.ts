import { NextRequest, NextResponse } from "next/server";
import { extractKey, authenticate } from "@/lib/keyStore";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getRotationPolicy,
  setRotationPolicy,
  evaluateKeyRotation,
} from "@/lib/rotationPolicy";
import { listKeys } from "@/lib/keyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/rotation-policy";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, method: string) {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method,
      status: 200,
      key: k,
      reason: "local-mode",
    });
    return { ok: true as const, key: k };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method,
      status: 403,
      key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { ok: false as const, res: err(403, "forbidden", "admin scope required") };
  }
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, k, ROUTE, method);
    if (mfaDenied) return { ok: false as const, res: mfaDenied };
  }
  return { ok: true as const, key: k };
}

// GET /api/admin/rotation-policy
// Returns the current workspace rotation policy plus a snapshot of every
// key with its age and rotation status. The snapshot is what powers the
// "aging keys" table in the admin UI without forcing the client to make
// N+1 calls.
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req, "GET");
  if (!gate.ok) return gate.res;
  const policy = await getRotationPolicy();
  const keys = await listKeys();
  const now = new Date();
  const snapshot = keys
    .filter((k) => !k.revoked)
    .map((k) => {
      const ev = evaluateKeyRotation(k, policy, now);
      return {
        id: k.id,
        label: k.label,
        prefix: k.prefix,
        created_at: k.created_at,
        age_days: ev.age_days,
        status: ev.status,
        days_until_rotation: ev.days_until_rotation,
        rotate_by: ev.rotate_by,
      };
    });
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "GET",
    status: 200,
    key: gate.key ?? null,
  });
  return NextResponse.json({ policy, keys: snapshot });
}

// PUT /api/admin/rotation-policy
// Body: { max_age_days?: number, warn_days?: number }
// 0 for max_age_days disables enforcement. warn_days controls when
// X-Key-Rotation-Status: warning appears on responses.
export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req, "PUT");
  if (!gate.ok) return gate.res;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const max = body?.max_age_days;
  const warn = body?.warn_days;
  if (max !== undefined && (!Number.isFinite(max) || max < 0 || max > 3650)) {
    return err(400, "bad_request", "max_age_days must be a non-negative integer up to 3650");
  }
  if (warn !== undefined && (!Number.isFinite(warn) || warn < 0 || warn > 3650)) {
    return err(400, "bad_request", "warn_days must be a non-negative integer up to 3650");
  }

  const before = await getRotationPolicy();
  let next;
  try {
    next = await setRotationPolicy({
      max_age_days: max,
      warn_days: warn,
      updated_by: gate.key?.id ?? null,
    });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("invalid_policy")) {
      return err(400, "invalid_policy", msg.replace(/^invalid_policy:\s*/, ""));
    }
    throw e;
  }

  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "PUT",
    status: 200,
    key: gate.key ?? null,
    reason: `rotation-policy:${before.max_age_days}/${before.warn_days}->${next.max_age_days}/${next.warn_days}`,
    details: { before, after: next },
  });

  return NextResponse.json(next);
}
