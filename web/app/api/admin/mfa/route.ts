// /api/admin/mfa — TOTP enrollment + verification + disable.
//
// GET    -> { status: { key_id, enrolled, last_verified_at, created_at } }
// POST   -> begin enrollment, returns secret + otpauth:// URI exactly once
// PUT    -> { code } verify a 6-digit code against the current enrollment
// DELETE -> disable MFA for this key (requires a valid current code to
//           prove possession, unless the key has not enrolled yet)
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set), same as the rest of
// /api/admin/*. A key always operates on its own MFA enrollment, not on
// other keys: scoping by the authenticated key id keeps blast radius small
// and means a compromised admin key cannot wipe MFA off the others.

import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  statusFor,
  startEnrollment,
  verifyAndMark,
  disable,
  getRecord,
} from "@/lib/totpStore";

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
  return { denied: null, key: k };
}

// Synthetic key id used in local mode so the store has something to key on.
const LOCAL_KEY_ID = "local";

function keyIdFor(key: any): string {
  return key?.id ?? LOCAL_KEY_ID;
}

function keyLabelFor(key: any): string {
  return key?.label ?? "local admin";
}

export async function GET(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, "/api/admin/mfa", "GET");
  if (denied) return denied;
  const status = await statusFor(keyIdFor(key));
  await recordAuditEvent({ req, route: "/api/admin/mfa", method: "GET", status: 200, key });
  return NextResponse.json({ status });
}

export async function POST(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, "/api/admin/mfa", "POST");
  if (denied) return denied;
  const init = await startEnrollment(keyIdFor(key), keyLabelFor(key));
  await recordAuditEvent({
    req,
    route: "/api/admin/mfa",
    method: "POST",
    status: 200,
    key,
    reason: "mfa-enroll-init",
  });
  return NextResponse.json(init);
}

export async function PUT(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, "/api/admin/mfa", "PUT");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^[0-9]{6}$/.test(code)) {
    await recordAuditEvent({
      req,
      route: "/api/admin/mfa",
      method: "PUT",
      status: 400,
      key,
      reason: "mfa-verify-bad-format",
    });
    return err(400, "bad_code", "code must be a 6-digit string");
  }
  const result = await verifyAndMark(keyIdFor(key), code);
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route: "/api/admin/mfa",
      method: "PUT",
      status: 401,
      key,
      reason: `mfa-verify-fail:${result.reason}`,
    });
    return err(401, "mfa_invalid", `code rejected: ${result.reason}`);
  }
  await recordAuditEvent({
    req,
    route: "/api/admin/mfa",
    method: "PUT",
    status: 200,
    key,
    reason: "mfa-verify-ok",
  });
  const status = await statusFor(keyIdFor(key));
  return NextResponse.json({ status, verified: true });
}

export async function DELETE(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, "/api/admin/mfa", "DELETE");
  if (denied) return denied;
  const id = keyIdFor(key);
  const existing = await getRecord(id);
  if (existing) {
    // Require a fresh code to prove the disabler still holds the device.
    const code = req.headers.get("x-mfa-code")?.trim() ?? "";
    if (!/^[0-9]{6}$/.test(code)) {
      await recordAuditEvent({
        req,
        route: "/api/admin/mfa",
        method: "DELETE",
        status: 401,
        key,
        reason: "mfa-disable-missing-code",
      });
      return err(401, "mfa_required", "X-MFA-Code header required to disable MFA");
    }
    const result = await verifyAndMark(id, code);
    if (!result.ok) {
      await recordAuditEvent({
        req,
        route: "/api/admin/mfa",
        method: "DELETE",
        status: 401,
        key,
        reason: `mfa-disable-reject:${result.reason}`,
      });
      return err(401, "mfa_invalid", "code rejected");
    }
  }
  const removed = await disable(id);
  await recordAuditEvent({
    req,
    route: "/api/admin/mfa",
    method: "DELETE",
    status: 200,
    key,
    reason: removed ? "mfa-disabled" : "mfa-not-enrolled",
  });
  return NextResponse.json({ ok: true, removed });
}
