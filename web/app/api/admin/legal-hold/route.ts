import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import {
  LEGAL_HOLD_SCOPES,
  listHolds,
  openHold,
  releaseHold,
  type LegalHoldScope,
} from "@/lib/legalHoldStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/legal-hold";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<{ denied: NextResponse | null; actor: string }> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 200, key: k, reason: "local-mode",
    });
    return { denied: null, actor: k?.id ?? "local" };
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), actor: "anon" };
  }
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, k, ROUTE, method);
    if (mfaDenied) return { denied: mfaDenied, actor: k.id };
  }
  return { denied: null, actor: k.id };
}

export async function GET(req: NextRequest) {
  const { denied, actor } = await requireAdmin(req, "GET");
  if (denied) return denied;
  const holds = await listHolds();
  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "legal_hold.list",
    details: { count: holds.length, actor },
  });
  return NextResponse.json({
    holds,
    available_scopes: LEGAL_HOLD_SCOPES,
  });
}

export async function POST(req: NextRequest) {
  const { denied, actor } = await requireAdmin(req, "POST");
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const matter = typeof body?.matter === "string" ? body.matter : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  const rawScopes: unknown = body?.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
    return err(400, "scopes_required", "scopes must be a non-empty array");
  }
  const scopes = rawScopes.filter((s): s is LegalHoldScope =>
    (LEGAL_HOLD_SCOPES as readonly string[]).includes(s as string),
  );
  if (scopes.length === 0) {
    return err(
      400,
      "scopes_invalid",
      `scopes must be a subset of [${LEGAL_HOLD_SCOPES.join(", ")}]`,
    );
  }
  let hold;
  try {
    hold = await openHold({ matter, reason, scopes, opened_by: actor });
  } catch (e: any) {
    if (e?.message === "matter_required") {
      return err(400, "matter_required", "matter is required (1..200 chars)");
    }
    throw e;
  }
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "legal_hold.opened",
    details: { id: hold.id, matter: hold.matter, scopes: hold.scopes },
  });
  await recordSafe({
    kind: "system",
    title: "Legal hold opened",
    body: `${hold.matter} (${hold.scopes.join(", ")})`,
    href: "/settings/legal-hold",
  }).catch(() => {});
  return NextResponse.json({ hold }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const { denied, actor } = await requireAdmin(req, "DELETE");
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return err(400, "id_required", "?id=<hold-id> is required");
  let body: any = {};
  try {
    if (req.headers.get("content-type")?.includes("json")) body = await req.json();
  } catch {
    // ignore
  }
  const released_reason =
    typeof body?.released_reason === "string" ? body.released_reason : "";
  let row;
  try {
    row = await releaseHold({ id, released_by: actor, released_reason });
  } catch (e: any) {
    if (e?.message === "not_found") return err(404, "not_found", "hold not found");
    if (e?.message === "already_released")
      return err(409, "already_released", "hold is already released");
    if (e?.message === "release_reason_required")
      return err(
        400,
        "release_reason_required",
        "released_reason must be at least 4 characters",
      );
    throw e;
  }
  await recordAuditEvent({
    req, route: ROUTE, method: "DELETE", status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "legal_hold.released",
    details: { id: row.id, matter: row.matter, released_reason: row.released_reason },
  });
  await recordSafe({
    kind: "system",
    title: "Legal hold released",
    body: row.matter,
    href: "/settings/legal-hold",
  }).catch(() => {});
  return NextResponse.json({ hold: row });
}
