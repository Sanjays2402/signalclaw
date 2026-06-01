import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  listRequests,
  requestApproval,
  type ApprovalStatus,
  publicView,
} from "@/lib/dualControlStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/approvals";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const VALID_STATUSES: ApprovalStatus[] = [
  "pending",
  "approved",
  "consumed",
  "cancelled",
  "expired",
];

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "GET");
  if (guard.denied) return guard.denied;
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  let status: ApprovalStatus | undefined;
  if (statusParam) {
    if (!VALID_STATUSES.includes(statusParam as ApprovalStatus)) {
      return err(400, "bad_request", "status must be one of " + VALID_STATUSES.join(", "));
    }
    status = statusParam as ApprovalStatus;
  }
  const rows = await listRequests({ status });
  return NextResponse.json({ requests: rows.map(publicView) });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req, ROUTE, "POST");
  if (guard.denied) return guard.denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const action = typeof body?.action === "string" ? body.action : "";
  const target = typeof body?.target === "string" ? body.target : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const requester = guard.key?.id ?? "local";

  const r = await requestApproval({
    action,
    target,
    reason,
    requested_by: requester,
  });
  if (!r.ok) return err(400, r.code, r.message);

  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "POST",
    status: 202,
    key: guard.key ?? null,
    reason: `dual_control:request:${r.request.action}`,
    details: { request_id: r.request.id, target: r.request.target },
  });
  return NextResponse.json(publicView(r.request), { status: 202 });
}
