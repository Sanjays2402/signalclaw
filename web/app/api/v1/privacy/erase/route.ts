// POST /api/v1/privacy/erase
// GET  /api/v1/privacy/erase
//
// Programmatic GDPR Article 17 (right to erasure). Mirrors the admin
// console flow so customers can wire deletion into their own data-subject
// pipelines, with the same safeguards: dry-run by default, explicit
// confirmation token, audit log preserved by default, and a hard block
// when any matching legal hold is open.
//
// Auth:    Authorization: Bearer <key>  (admin scope required; erasure is
//          a destructive workspace-wide operation and we do not let a
//          stolen read/trade key wipe the install)
// Body:    { confirm?: "DELETE", dry_run?: boolean,
//            wipe_compliance?: boolean, wipe_audit?: boolean }
//          dry_run defaults to true. To execute you must send
//          {"confirm":"DELETE","dry_run":false}.
// GET returns the same dry-run plan with no side effects so a client can
// preview before posting.
import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { recordSafe } from "@/lib/activityStore";
import {
  describeErase,
  eraseAll,
  type EraseOptions,
} from "@/lib/privacyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/v1/privacy/erase";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function gate(req: NextRequest, method: string) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 401, key: null,
      reason: "unauthorized",
    });
    return { key: null, denied: err(401, "unauthorized", "missing or invalid api key") };
  }
  if (!key.scopes.includes("admin")) {
    await recordAuditEvent({
      req, route: ROUTE, method, status: 403, key,
      reason: "forbidden:admin-required",
    });
    return { key, denied: err(403, "forbidden", "admin scope required to erase workspace data") };
  }
  return { key, denied: null as NextResponse | null };
}

function parseOpts(input: any): EraseOptions {
  return {
    wipeCompliance: input?.wipe_compliance === true,
    wipeAudit: input?.wipe_audit === true,
  };
}

export async function GET(req: NextRequest) {
  const { key, denied } = await gate(req, "GET");
  if (denied || !key) return denied!;
  return enforceRateLimit(req, key, ROUTE, async () => {
    const url = new URL(req.url);
    const opts: EraseOptions = {
      wipeCompliance: url.searchParams.get("wipe_compliance") === "true",
      wipeAudit: url.searchParams.get("wipe_audit") === "true",
    };
    const plan = describeErase(opts);
    await recordAuditEvent({
      req, route: ROUTE, method: "GET", status: 200, key,
      reason: "privacy.erase.preview",
      details: { ...opts, will_remove_count: plan.willRemove.length },
    });
    return NextResponse.json({ dry_run: true, options: opts, plan });
  });
}

export async function POST(req: NextRequest) {
  const { key, denied } = await gate(req, "POST");
  if (denied || !key) return denied!;
  return enforceRateLimit(req, key, ROUTE, async () => {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return err(400, "bad_json", "request body must be valid JSON");
    }
    const opts = parseOpts(body);
    const dryRun = body?.dry_run !== false; // default true; must opt out explicitly
    if (dryRun) {
      const plan = describeErase(opts);
      await recordAuditEvent({
        req, route: ROUTE, method: "POST", status: 200, key,
        reason: "privacy.erase.preview",
        details: { ...opts, will_remove_count: plan.willRemove.length },
      });
      return NextResponse.json({ dry_run: true, options: opts, plan });
    }
    const confirm = typeof body?.confirm === "string" ? body.confirm : "";
    if (confirm !== "DELETE") {
      await recordAuditEvent({
        req, route: ROUTE, method: "POST", status: 400, key,
        reason: "privacy.erase.unconfirmed",
      });
      return err(
        400,
        "confirm_required",
        'pass {"confirm":"DELETE","dry_run":false} to execute erase',
      );
    }
    let summary;
    try {
      summary = await eraseAll(opts);
    } catch (e: any) {
      if (e?.code === "legal_hold_active") {
        const holds = (e.holds || []).map((h: any) => ({
          id: h.id,
          matter: h.matter,
          scopes: h.scopes,
          opened_at: h.opened_at,
        }));
        await recordAuditEvent({
          req, route: ROUTE, method: "POST", status: 409, key,
          reason: "privacy.erase.blocked_by_legal_hold",
          details: { holds: holds.length },
        });
        return NextResponse.json(
          {
            error: {
              code: "legal_hold_active",
              message:
                "Erase blocked by an active legal hold. Release the matter before retrying.",
            },
            holds,
          },
          { status: 409 },
        );
      }
      throw e;
    }
    await recordAuditEvent({
      req, route: ROUTE, method: "POST", status: 200, key,
      reason: "privacy.erase.executed",
      details: {
        ...opts,
        removed_count: summary.removed.length,
        preserved_count: summary.preserved.length,
        bytes_freed: summary.bytes_freed,
      },
    });
    await recordSafe({
      kind: "system",
      title: "Workspace data erased via API",
      body: `Removed ${summary.removed.length} file(s), freed ${summary.bytes_freed} bytes. Preserved ${summary.preserved.length}.`,
      href: "/settings/privacy",
    }).catch(() => { /* activity store may itself have been wiped */ });
    return NextResponse.json(summary);
  });
}
