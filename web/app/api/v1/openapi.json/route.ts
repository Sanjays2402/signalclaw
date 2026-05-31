import { NextRequest, NextResponse } from "next/server";
import { buildSpec } from "@/lib/openapiSpec";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/openapi.json
// Public OpenAPI 3.1 specification of the v1 surface. Served unauthenticated
// on purpose: procurement, security review, and client codegen all need to
// fetch it before any credentials exist. The spec itself describes the auth
// schemes (bearer + x-api-key) and per-operation scopes.
//
// Response is JSON with explicit caching headers so a CDN can cache the
// spec while routes themselves stay dynamic.
export async function GET(req: NextRequest) {
  const origin = (() => {
    try { return new URL(req.url).origin; } catch { return undefined; }
  })();
  const spec = buildSpec(origin);
  const body = JSON.stringify(spec, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      // CORS: allow tooling (Swagger UI, Postman, codegen) to pull the spec.
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "x-openapi-version": "3.1.0",
    },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}
