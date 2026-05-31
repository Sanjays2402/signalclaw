// SCIM 2.0 bearer-auth helper. Every /scim/v2/* route runs the request
// through this gate before touching state. A failed auth is recorded to
// the same tamper-evident audit chain the rest of the app uses, so a
// SOC2 reviewer can trace every IdP push attempt (success or denied).
import { NextRequest, NextResponse } from "next/server";
import { extractBearer, verifyToken, scimError } from "@/lib/scimStore";
import { recordAuditEvent } from "@/lib/auditStore";

export async function requireScim(
  req: NextRequest,
  route: string,
): Promise<NextResponse | null> {
  const tok = extractBearer(req);
  const ok = await verifyToken(tok);
  if (!ok) {
    await recordAuditEvent({
      req,
      route,
      method: req.method,
      status: 401,
      key: null,
      reason: tok ? "scim:bad-token" : "scim:no-token",
    });
    return NextResponse.json(scimError(401, "unauthorized"), {
      status: 401,
      headers: { "content-type": "application/scim+json" },
    });
  }
  return null;
}

export function scimJson(body: any, init?: { status?: number }) {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "application/scim+json" },
  });
}

export function scimBaseUrl(req: NextRequest): string {
  const proto =
    req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.nextUrl.host;
  return `${proto}://${host}`;
}
