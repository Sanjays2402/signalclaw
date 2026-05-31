// SIEM sink admin API.
//
// GET  /api/admin/siem            -> public view of the sink config
// PUT  /api/admin/siem            -> update fields (enabled,url,secret,...)
// POST /api/admin/siem/test       -> dispatch a synthetic event, return attempt
// GET  /api/admin/siem/deliveries -> recent dispatch attempts (in memory)
//
// Auth: admin scope (when SIGNALCLAW_ADMIN_KEY is set). Mutations require
// admin MFA, mirroring the rest of /api/admin/*. Every call is audited.
import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { authenticate, extractKey } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getSink,
  updateSink,
  SinkValidationError,
} from "@/lib/siemSinkStore";

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
      req, route, method, status: 403, key: k ?? null,
      reason: "forbidden:admin-required",
    });
    return { denied: err(403, "forbidden", "admin scope required"), key: k };
  }
  if (method !== "GET") {
    const mfaDenied = await enforceAdminMfa(req, k, route, method);
    if (mfaDenied) return { denied: mfaDenied, key: k };
  }
  return { denied: null, key: k };
}

export async function GET(req: NextRequest) {
  const route = "/api/admin/siem";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const sink = await getSink();
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: key ?? null });
  return NextResponse.json(sink);
}

export async function PUT(req: NextRequest) {
  const route = "/api/admin/siem";
  const { denied, key } = await requireAdmin(req, route, "PUT");
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: "bad_json" });
    return err(400, "bad_json", "request body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "body must be an object");
  }

  const allowed = ["enabled", "url", "secret", "extra_header_name", "extra_header_value", "timeout_ms"];
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) {
      return err(400, "unknown_field", `unknown field: ${k}`);
    }
  }

  try {
    const sink = await updateSink(body);
    await recordAuditEvent({
      req, route, method: "PUT", status: 200, key: key ?? null,
      details: { enabled: sink.enabled, url: sink.url, secret_set: sink.secret_set },
    });
    return NextResponse.json(sink);
  } catch (e) {
    if (e instanceof SinkValidationError) {
      await recordAuditEvent({ req, route, method: "PUT", status: 400, key: key ?? null, reason: e.code });
      return err(400, e.code, e.message);
    }
    throw e;
  }
}
