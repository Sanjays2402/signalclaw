// SCIM 2.0 /Users/{id} (GET, PUT, PATCH, DELETE).
import { NextRequest } from "next/server";
import { requireScim, scimJson, scimBaseUrl } from "@/lib/scimGuard";
import {
  getUser,
  replaceUser,
  patchUser,
  deleteUser,
  parseScimUserBody,
  toScimResource,
  scimError,
} from "@/lib/scimStore";
import { recordAuditEvent } from "@/lib/auditStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function routeFor(id: string) {
  return `/api/scim/v2/Users/${id}`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const route = routeFor(id);
  const denied = await requireScim(req, route);
  if (denied) return denied;
  const base = scimBaseUrl(req);
  const u = await getUser(id);
  if (!u) {
    await recordAuditEvent({ req, route, method: "GET", status: 404, key: null, reason: "scim:not-found" });
    return scimJson(scimError(404, "user not found"), { status: 404 });
  }
  await recordAuditEvent({ req, route, method: "GET", status: 200, key: null, reason: "scim:get" });
  return scimJson(toScimResource(u, base));
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const route = routeFor(id);
  const denied = await requireScim(req, route);
  if (denied) return denied;
  const base = scimBaseUrl(req);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return scimJson(scimError(400, "invalid JSON body"), { status: 400 });
  }
  try {
    const input = parseScimUserBody(body);
    const u = await replaceUser(id, input);
    if (!u) {
      await recordAuditEvent({ req, route, method: "PUT", status: 404, key: null, reason: "scim:not-found" });
      return scimJson(scimError(404, "user not found"), { status: 404 });
    }
    await recordAuditEvent({
      req, route, method: "PUT", status: 200, key: null,
      reason: "scim:replace", details: { id: u.id, active: u.active },
    });
    return scimJson(toScimResource(u, base));
  } catch (e: any) {
    const status = e?.status || 500;
    return scimJson(scimError(status, String(e?.message ?? e), e?.scimType), { status });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const route = routeFor(id);
  const denied = await requireScim(req, route);
  if (denied) return denied;
  const base = scimBaseUrl(req);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return scimJson(scimError(400, "invalid JSON body"), { status: 400 });
  }
  const ops = Array.isArray(body?.Operations) ? body.Operations : [];
  if (ops.length === 0) {
    return scimJson(scimError(400, "Operations array required"), { status: 400 });
  }
  const u = await patchUser(id, ops);
  if (!u) {
    await recordAuditEvent({ req, route, method: "PATCH", status: 404, key: null, reason: "scim:not-found" });
    return scimJson(scimError(404, "user not found"), { status: 404 });
  }
  await recordAuditEvent({
    req, route, method: "PATCH", status: 200, key: null,
    reason: "scim:patch", details: { id: u.id, active: u.active, ops: ops.length },
  });
  return scimJson(toScimResource(u, base));
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const route = routeFor(id);
  const denied = await requireScim(req, route);
  if (denied) return denied;
  const ok = await deleteUser(id);
  if (!ok) {
    await recordAuditEvent({ req, route, method: "DELETE", status: 404, key: null, reason: "scim:not-found" });
    return scimJson(scimError(404, "user not found"), { status: 404 });
  }
  await recordAuditEvent({ req, route, method: "DELETE", status: 204, key: null, reason: "scim:delete" });
  return new Response(null, { status: 204 });
}
