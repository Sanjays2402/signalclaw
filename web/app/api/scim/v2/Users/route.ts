// SCIM 2.0 /Users (list, create).
import { NextRequest } from "next/server";
import { requireScim, scimJson, scimBaseUrl } from "@/lib/scimGuard";
import {
  listUsers,
  createUser,
  parseScimUserBody,
  toScimResource,
  scimError,
} from "@/lib/scimStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/scim/v2/Users";

export async function GET(req: NextRequest) {
  const denied = await requireScim(req, ROUTE);
  if (denied) return denied;
  const base = scimBaseUrl(req);
  const sp = req.nextUrl.searchParams;
  const filter = sp.get("filter") || undefined;
  const startIndex = Math.max(1, Number.parseInt(sp.get("startIndex") || "1", 10) || 1);
  const count = Math.min(200, Math.max(0, Number.parseInt(sp.get("count") || "100", 10) || 100));
  const all = await listUsers(filter);
  const page = all.slice(startIndex - 1, startIndex - 1 + count);
  await recordAuditEvent({
    req,
    route: ROUTE,
    method: "GET",
    status: 200,
    key: null,
    reason: "scim:list",
    details: { filter: filter ?? null, total: all.length },
  });
  return scimJson({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: all.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map((u) => toScimResource(u, base)),
  });
}

export async function POST(req: NextRequest) {
  const denied = await requireScim(req, ROUTE);
  if (denied) return denied;
  const base = scimBaseUrl(req);
  let body: any;
  try {
    body = await req.json();
  } catch {
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 400, key: null,
      reason: "scim:bad-json",
    });
    return scimJson(scimError(400, "invalid JSON body"), { status: 400 });
  }
  try {
    const input = parseScimUserBody(body);
    const u = await createUser(input);
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 201, key: null,
      reason: "scim:create", details: { id: u.id, userName: u.userName },
    });
    return scimJson(toScimResource(u, base), { status: 201 });
  } catch (e: any) {
    const status = e?.status || 500;
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status, key: null,
      reason: "scim:create-failed", details: { message: String(e?.message ?? e) },
    });
    return scimJson(scimError(status, String(e?.message ?? e), e?.scimType), { status });
  }
}
