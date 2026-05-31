// Shared admin gate for management endpoints outside `/api/admin/*`.
//
// Matches the behaviour the `/api/admin/network-policy` and `/api/admin/keys`
// routes ship: in local single-user mode (no `SIGNALCLAW_ADMIN_KEY` env var)
// the call is allowed and a `local-mode` line is written to the tamper-evident
// audit chain; in production posture (`SIGNALCLAW_ADMIN_KEY` set) the request
// must present an authenticated key with the `admin` scope or the request is
// refused with `403 forbidden` and a `forbidden:admin-required` audit line.
//
// This file exists so newer surfaces (webhooks management, future workspace
// settings) can adopt the same gate verbatim instead of copy-pasting the
// network-policy helper. The policy lives in `adminGuardCore` so it stays
// unit-testable without booting Next; this file is just the audit + Response
// adapter on top.
import { NextRequest, NextResponse } from "next/server";
import { decideAdmin } from "@/lib/adminGuardCore";
import { recordAuditEvent } from "@/lib/auditStore";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import type { StoredKey } from "@/lib/keyStore";

export type AdminGuardResult = {
  denied: NextResponse | null;
  key: StoredKey | null;
};

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function requireAdmin(
  req: NextRequest,
  route: string,
  method: string,
): Promise<AdminGuardResult> {
  const d = await decideAdmin(req);
  if (!d.allowed) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 403,
      key: d.key,
      reason: d.reason,
    });
    return { denied: err(403, "forbidden", "admin scope required"), key: d.key };
  }
  await recordAuditEvent({
    req,
    route,
    method,
    status: 200,
    key: d.key,
    reason: d.reason,
  });
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, d.key, route, method);
    if (mfaDenied) return { denied: mfaDenied, key: d.key };
  }
  return { denied: null, key: d.key };
}
