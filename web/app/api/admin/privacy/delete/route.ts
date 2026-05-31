import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import {
  describeErase,
  eraseAll,
  type EraseOptions,
} from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/privacy/delete";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(
  req: NextRequest,
  method: string,
): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return err(403, "forbidden", "admin scope required");
  }
  if ((method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, "/api/admin/privacy/delete", (method));
    if (__mfaDenied) return __mfaDenied;
  }
  return null;
}

// GET returns the dry-run plan so the UI can show "this will remove X, keep Y".
export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req, "GET");
  if (denied) return denied;
  const url = new URL(req.url);
  const opts: EraseOptions = {
    wipeCompliance: url.searchParams.get("wipe_compliance") === "true",
    wipeAudit: url.searchParams.get("wipe_audit") === "true",
  };
  const plan = describeErase(opts);
  await recordAuditEvent({
    req, route: ROUTE, method: "GET", status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "privacy.delete.preview",
    details: { ...opts, will_remove_count: plan.willRemove.length },
  });
  return NextResponse.json({ dry_run: true, options: opts, plan });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req, "POST");
  if (denied) return denied;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  const confirm = typeof body?.confirm === "string" ? body.confirm : "";
  if (confirm !== "DELETE") {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 400,
      key: await authenticate(extractKey(req), { req }),
      reason: "privacy.delete.unconfirmed",
    });
    return err(400, "confirm_required", 'pass {"confirm":"DELETE"} to proceed');
  }
  const opts: EraseOptions = {
    wipeCompliance: body?.wipe_compliance === true,
    wipeAudit: body?.wipe_audit === true,
  };
  const summary = await eraseAll(opts);
  await recordAuditEvent({
    req, route: ROUTE, method: "POST", status: 200,
    key: await authenticate(extractKey(req), { req }),
    reason: "privacy.delete.executed",
    details: {
      ...opts,
      removed_count: summary.removed.length,
      preserved_count: summary.preserved.length,
      bytes_freed: summary.bytes_freed,
    },
  });
  await recordSafe({
    kind: "system",
    title: "Workspace data erased",
    body: `Removed ${summary.removed.length} file(s), freed ${summary.bytes_freed} bytes. Preserved ${summary.preserved.length}.`,
    href: "/settings/privacy",
  }).catch(() => { /* activity log may itself have been wiped */ });
  return NextResponse.json(summary);
}
