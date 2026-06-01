// DPA acceptance ledger admin API.
//
// GET    /api/admin/dpa  -> current DPA version, active acceptance,
//                            full ledger (most recent first).
// POST   /api/admin/dpa  -> record an acceptance of the current DPA.
//                            Body: { signatory_name, signatory_title,
//                            customer_entity, note? }
// DELETE /api/admin/dpa  -> record a withdrawal of the active acceptance.
//                            Body: { reason }
//
// Auth: admin scope, MFA on mutations. Every call writes a tamper-evident
// audit row that mirrors the ledger entry, so a SOC2 reviewer can cross
// check the file against the audit chain.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import { clientIpFromRequest } from "@/lib/ipMatch";
import {
  accept,
  withdraw,
  getState,
  CURRENT_DPA,
} from "@/lib/dpaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/dpa";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<{ denied: NextResponse | null; key: any; actor: string }> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    return { denied: null, key: k, actor: k?.id ?? "local" };
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
    return {
      denied: err(403, "forbidden", "admin scope required"),
      key: k,
      actor: "anon",
    };
  }
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, k, ROUTE, method);
    if (mfaDenied) return { denied: mfaDenied, key: k, actor: k.id };
  }
  return { denied: null, key: k, actor: k.id };
}

export async function GET(req: NextRequest) {
  const { denied, key } = await requireAdmin(req, "GET");
  if (denied) return denied;
  const state = await getState();
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "GET",
    status: 200,
    key,
    reason: "dpa.list",
    details: {
      current_version: state.current.version,
      active_version: state.active?.dpa_version ?? null,
      needs_re_acceptance: state.needs_re_acceptance,
      acceptance_count: state.acceptances.length,
    },
  });
  return NextResponse.json(state);
}

export async function POST(req: NextRequest) {
  const { denied, key, actor } = await requireAdmin(req, "POST");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const ip = clientIpFromRequest(req);
  const ua = req.headers.get("user-agent") ?? null;
  const result = await accept({
    signatory_name: typeof body?.signatory_name === "string" ? body.signatory_name : "",
    signatory_title: typeof body?.signatory_title === "string" ? body.signatory_title : "",
    customer_entity: typeof body?.customer_entity === "string" ? body.customer_entity : "",
    note: typeof body?.note === "string" ? body.note : "",
    actor_id: actor,
    actor_email: typeof body?.actor_email === "string" ? body.actor_email : null,
    ip,
    user_agent: ua,
  });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "POST",
      status: 400,
      key,
      reason: `dpa.accept_rejected:${result.code}`,
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "POST",
    status: 200,
    key,
    reason: "dpa.accepted",
    details: {
      id: result.acceptance.id,
      dpa_version: result.acceptance.dpa_version,
      dpa_sha256: result.acceptance.dpa_sha256,
      customer_entity: result.acceptance.customer_entity,
      signatory_name: result.acceptance.signatory_name,
      signatory_title: result.acceptance.signatory_title,
      superseded_id: result.superseded?.id ?? null,
      actor,
    },
  });
  recordSafe({
    kind: "system",
    title: `DPA ${result.acceptance.dpa_version} accepted`,
    body: `${result.acceptance.signatory_name} (${result.acceptance.signatory_title}) for ${result.acceptance.customer_entity}`,
    href: "/settings/dpa",
  });
  return NextResponse.json({ ok: true, acceptance: result.acceptance, superseded: result.superseded });
}

export async function DELETE(req: NextRequest) {
  const { denied, key, actor } = await requireAdmin(req, "DELETE");
  if (denied) return denied;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // empty body allowed -> validation below rejects it
  }
  const ip = clientIpFromRequest(req);
  const ua = req.headers.get("user-agent") ?? null;
  const result = await withdraw({
    reason: typeof body?.reason === "string" ? body.reason : "",
    actor_id: actor,
    actor_email: typeof body?.actor_email === "string" ? body.actor_email : null,
    ip,
    user_agent: ua,
  });
  if (!result.ok) {
    const status = result.code === "no_active" ? 409 : 400;
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "DELETE",
      status,
      key,
      reason: `dpa.withdraw_rejected:${result.code}`,
    });
    return err(status, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "DELETE",
    status: 200,
    key,
    reason: "dpa.withdrawn",
    details: {
      id: result.withdrawal.id,
      withdrew_id: result.withdrew.id,
      dpa_version: result.withdrawal.dpa_version,
      reason: result.withdrawal.note,
      actor,
    },
  });
  recordSafe({
    kind: "system",
    title: `DPA ${result.withdrawal.dpa_version} acceptance withdrawn`,
    body: result.withdrawal.note.slice(0, 200),
    href: "/settings/dpa",
  });
  return NextResponse.json({ ok: true, withdrawal: result.withdrawal });
}

// Expose the pinned current version for clients that only need metadata.
export async function HEAD() {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "x-dpa-version": CURRENT_DPA.version,
      "x-dpa-sha256": CURRENT_DPA.sha256,
    },
  });
}
