import { NextRequest, NextResponse } from "next/server";
import { extractKey, authenticate } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getResidencyPolicy,
  setResidencyPolicy,
  detectRequestRegion,
  type Region,
  type ResidencyMode,
} from "@/lib/residencyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/residency";

const REGIONS: ReadonlyArray<Region> = ["us", "eu", "ap", "global"];
const MODES: ReadonlyArray<ResidencyMode> = ["off", "monitor", "enforce"];

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function requireAdmin(req: NextRequest, method: string) {
  const k = await authenticate(extractKey(req));
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({
      req,
      route: ROUTE,
      method,
      status: 200,
      key: k,
      reason: "local-mode",
    });
    return { ok: true as const, key: k };
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
      ok: false as const,
      res: err(403, "forbidden", "admin scope required"),
    };
  }
  return { ok: true as const, key: k };
}

// GET /api/admin/residency
// Returns the active policy plus what region this very request resolved
// to, so the admin UI can warn the operator before they enable enforce
// mode from a region the policy would block.
export async function GET(req: NextRequest) {
  const gate = await requireAdmin(req, "GET");
  if (!gate.ok) return gate.res;
  const policy = await getResidencyPolicy();
  const detected = detectRequestRegion(req);
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "GET",
    status: 200,
    key: gate.key ?? null,
  });
  return NextResponse.json({
    policy,
    self: detected,
    options: { regions: REGIONS, modes: MODES },
  });
}

// PUT /api/admin/residency
// Body: { region?: Region, mode?: ResidencyMode }
export async function PUT(req: NextRequest) {
  const gate = await requireAdmin(req, "PUT");
  if (!gate.ok) return gate.res;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }

  const region = body?.region;
  const mode = body?.mode;
  if (
    region !== undefined &&
    (typeof region !== "string" || !REGIONS.includes(region as Region))
  ) {
    return err(400, "bad_request", `region must be one of ${REGIONS.join(", ")}`);
  }
  if (
    mode !== undefined &&
    (typeof mode !== "string" || !MODES.includes(mode as ResidencyMode))
  ) {
    return err(400, "bad_request", `mode must be one of ${MODES.join(", ")}`);
  }

  const before = await getResidencyPolicy();
  let next;
  try {
    next = await setResidencyPolicy({
      region: region as Region | undefined,
      mode: mode as ResidencyMode | undefined,
      updated_by: gate.key?.id ?? null,
    });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("invalid_policy")) {
      return err(400, "invalid_policy", msg.replace(/^invalid_policy:\s*/, ""));
    }
    throw e;
  }

  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "PUT",
    status: 200,
    key: gate.key ?? null,
    reason: `residency:${before.region}/${before.mode}->${next.region}/${next.mode}`,
    details: { before, after: next },
  });

  return NextResponse.json(next);
}
