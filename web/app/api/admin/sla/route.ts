// SLA commitment register admin API.
//
// GET  /api/admin/sla  -> current commitment, full version history.
// POST /api/admin/sla  -> publish a new SLA version. Body: full
//   commitment payload (see slaStore.PublishInput). Each publish
//   appends to history, never mutates the previous version. MFA
//   required on mutations. Audit row written with the new version
//   number and notes hash so a reviewer can pin "what SLA was in
//   force on date X" against the audit chain.
//
// There is intentionally no DELETE: SLA commitments must be a strict
// append-only ledger to be useful in MSA disputes. To retire a
// commitment, publish a new one.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { publish, getState, type ResponseMatrix, type CreditTier } from "@/lib/slaStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/sla";

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
    reason: "sla.list",
    details: {
      current_version: state.current?.version ?? null,
      history_count: state.history.length,
    },
  });
  return NextResponse.json(state);
}

function asMatrix(v: any): ResponseMatrix | null {
  if (!v || typeof v !== "object") return null;
  const m: ResponseMatrix = {
    sev1: Number(v.sev1),
    sev2: Number(v.sev2),
    sev3: Number(v.sev3),
    sev4: Number(v.sev4),
  };
  return m;
}

function asLadder(v: any): CreditTier[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      below_uptime_bps: Number(t.below_uptime_bps),
      credit_pct: Number(t.credit_pct),
    }));
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
  const result = await publish({
    uptime_target_bps: Number(body?.uptime_target_bps),
    response_targets: asMatrix(body?.response_targets) ?? ({} as ResponseMatrix),
    credit_ladder: asLadder(body?.credit_ladder),
    notes: typeof body?.notes === "string" ? body.notes : "",
    support_email: typeof body?.support_email === "string" ? body.support_email : "",
    status_page_url:
      typeof body?.status_page_url === "string" ? body.status_page_url : null,
    security_email:
      typeof body?.security_email === "string" ? body.security_email : null,
    actor_id: actor,
    actor_email: typeof body?.actor_email === "string" ? body.actor_email : null,
  });
  if (!result.ok) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method: "POST",
      status: 400,
      key,
      reason: `sla.publish_rejected:${result.code}`,
    });
    return err(400, result.code, result.message);
  }
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "POST",
    status: 200,
    key,
    reason: "sla.published",
    details: {
      version: result.commitment.version,
      uptime_target_bps: result.commitment.uptime_target_bps,
      notes_sha256: result.commitment.notes_sha256,
      effective_at: result.commitment.effective_at,
    },
  });
  return NextResponse.json({ commitment: result.commitment });
}
