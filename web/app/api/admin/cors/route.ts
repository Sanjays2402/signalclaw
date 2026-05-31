// Read-only admin readout of the effective CORS policy.
//
// GET /api/admin/cors  -> {
//   production: boolean,           // SIGNALCLAW_ADMIN_KEY is set
//   origins: string[],             // parsed SIGNALCLAW_CORS_ORIGINS
//   loopback_default: boolean,     // local-mode default admits localhost
//   allow_methods: string,
//   allow_headers: string,
//   expose_headers: string,
//   max_age: string,
// }
//
// Why GET only: the allowlist is env-driven on purpose so a hosting team
// controls it through their deploy pipeline, not the dashboard. Exposing
// a writable surface here would let an admin compromise widen browser
// reach without a deploy artifact. This route is the readout an enterprise
// IT reviewer asks for during procurement.
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminGuard";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getPolicy,
  ALLOW_METHODS,
  ALLOW_HEADERS,
  EXPOSE_HEADERS,
  MAX_AGE,
} from "@/lib/corsPolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const route = "/api/admin/cors";
  const { denied, key } = await requireAdmin(req, route, "GET");
  if (denied) return denied;
  const policy = getPolicy();
  await recordAuditEvent({
    req,
    route,
    method: "GET",
    status: 200,
    key: key ?? null,
    details: {
      production: policy.production,
      origin_count: policy.origins.length,
      loopback_default: policy.loopback_default,
    },
  });
  return NextResponse.json({
    production: policy.production,
    origins: policy.origins,
    loopback_default: policy.loopback_default,
    allow_methods: ALLOW_METHODS,
    allow_headers: ALLOW_HEADERS,
    expose_headers: EXPOSE_HEADERS,
    max_age: MAX_AGE,
  });
}
