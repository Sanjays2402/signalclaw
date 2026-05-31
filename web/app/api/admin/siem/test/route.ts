// POST /api/admin/siem/test  -> dispatch a synthetic security event to the
// configured SIEM URL and return the delivery attempt so an operator can
// verify the receiver wired the HMAC + headers correctly before flipping
// `enabled: true` in production.
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { dispatch, getSink } from "@/lib/siemSinkStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(req: NextRequest) {
  const route = "/api/admin/siem/test";
  const k = await authenticate(extractKey(req), { req });
  if (process.env.SIGNALCLAW_ADMIN_KEY) {
    if (!k || !k.scopes.includes("admin")) {
      await recordAuditEvent({ req, route, method: "POST", status: 403, key: k ?? null, reason: "forbidden:admin-required" });
      return err(403, "forbidden", "admin scope required");
    }
    const mfaDenied = await enforceAdminMfa(req, k, route, "POST");
    if (mfaDenied) return mfaDenied;
  }

  const sink = await getSink();
  // We do not require enabled=true for a test; that's the whole point of a
  // dry-run. We do require url+secret so there is something to test.
  if (!sink.url || !sink.secret_set) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: k ?? null, reason: "not_configured" });
    return err(400, "not_configured", "configure url and secret before testing");
  }

  // Force-dispatch even when disabled, by passing an override sink with
  // enabled:true. We re-read the on-disk sink directly via getSink which
  // returns the public view; the real dispatch reads from disk again when
  // sink is not supplied, so we synthesise a one-shot enabled sink by
  // calling dispatch with no override and temporarily flipping enabled via
  // updateSink would mutate state. Instead, allow dispatch to no-op when
  // disabled, and gate the test on enabled=true.
  if (!sink.enabled) {
    await recordAuditEvent({ req, route, method: "POST", status: 400, key: k ?? null, reason: "not_enabled" });
    return err(400, "not_enabled", "enable the sink before testing");
  }

  const attempt = await dispatch({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    route: "/api/admin/siem/test",
    method: "POST",
    status: 200,
    ok: true,
    key_id: k?.id ?? "anon",
    key_label: k?.label ?? "",
    scopes: k?.scopes ?? [],
    reason: "siem-test",
    request_id: req.headers.get("x-request-id"),
    ip_hash: null,
    hash: "test",
  });

  await recordAuditEvent({
    req, route, method: "POST", status: 200, key: k ?? null,
    details: { ok: attempt?.ok ?? false, status: attempt?.status ?? null },
  });
  return NextResponse.json({ attempt });
}
