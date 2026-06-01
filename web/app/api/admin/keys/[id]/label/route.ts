import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import {
  extractKey,
  authenticate,
  getKey,
  setKeyLabel,
  publicView,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
  route: string,
): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route, method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route, method, status: 200, key: k });
  if (method !== "GET") {
    const denied = await enforceAdminMfa(req, k, route, method);
    if (denied) return denied;
  }
  return null;
}

// PUT /api/admin/keys/:id/label
// Body: { label: string }
// Renames an API key in place. The secret, scopes, role, and IP
// allowlist are unchanged; only the human-readable label moves. Labels
// are trimmed and clamped to 80 chars; empty / whitespace input is
// rejected with 400 so the inventory never loses a name. Admin scope +
// MFA gated like every other mutating admin route, and the audit log
// captures the before/after transition for procurement review.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/label`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const raw = body?.label;
  if (typeof raw !== "string") {
    return err(400, "bad_request", "label must be a string");
  }

  const existing = await getKey(id);
  if (!existing) return err(404, "not_found", "key not found");
  if (existing.revoked) return err(409, "revoked", "cannot edit a revoked key");
  if (id === "env-admin") {
    return err(409, "forbidden_target", "cannot rename the env admin");
  }

  let updated;
  try {
    updated = await setKeyLabel(id, raw);
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("invalid_label")) {
      return err(400, "invalid_label", msg.replace(/^invalid_label:\s*/, ""));
    }
    throw e;
  }
  if (!updated) return err(404, "not_found", "key not found");

  const beforeLabel = existing.label ?? "";
  await recordAuditEvent({
    req,
    route,
    method: "PUT",
    status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: `label:${beforeLabel.slice(0, 60)}->${updated.label.slice(0, 60)}`,
  });

  return NextResponse.json(publicView(updated));
}
