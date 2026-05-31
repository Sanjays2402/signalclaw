import { NextRequest, NextResponse } from "next/server";
import { enforceAdminMfa } from "@/lib/adminMfaGuard";
import { extractKey, authenticate } from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  getQuotaForKey,
  setQuotaForKey,
  getUsage,
  nextPeriodResetIso,
  periodOf,
  DEFAULT_MONTHLY_QUOTA,
} from "@/lib/monthlyQuotaStore";

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
  if ((method) !== "GET") {
    const __mfaDenied = await enforceAdminMfa(req, k, route, (method));
    if (__mfaDenied) return __mfaDenied;
  }
  return null;
}

// GET /api/admin/keys/:id/monthly-quota
// Returns the current per-key monthly request cap, current period usage,
// and the default fallback (0 = unlimited).
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/monthly-quota`;
  const denied = await requireAdmin(req, "GET", route);
  if (denied) return denied;
  const quota = await getQuotaForKey(id);
  const usage = await getUsage(id);
  const limit = quota;
  const remaining = limit === 0 ? null : Math.max(0, limit - usage.count);
  return NextResponse.json({
    key_id: id,
    monthly_quota: limit,
    default_monthly_quota: DEFAULT_MONTHLY_QUOTA,
    is_override: limit !== DEFAULT_MONTHLY_QUOTA,
    unlimited: limit === 0,
    period: usage.period,
    used: usage.count,
    remaining,
    resets_at: nextPeriodResetIso(),
  });
}

// PUT /api/admin/keys/:id/monthly-quota  { quota: number | null }
// 0 = unlimited. null = reset to default. Positive integer = hard cap.
export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const route = `/api/admin/keys/${id}/monthly-quota`;
  const denied = await requireAdmin(req, "PUT", route);
  if (denied) return denied;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "request body must be valid JSON");
  }
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }
  const raw = body.quota;
  if (raw !== null && (typeof raw !== "number" || !Number.isFinite(raw))) {
    return err(400, "bad_quota", "quota must be a non-negative number or null");
  }
  try {
    const next = await setQuotaForKey(id, raw === null ? null : raw);
    const usage = await getUsage(id);
    const remaining = next === 0 ? null : Math.max(0, next - usage.count);
    return NextResponse.json({
      key_id: id,
      monthly_quota: next,
      default_monthly_quota: DEFAULT_MONTHLY_QUOTA,
      is_override: next !== DEFAULT_MONTHLY_QUOTA,
      unlimited: next === 0,
      period: periodOf(),
      used: usage.count,
      remaining,
      resets_at: nextPeriodResetIso(),
    });
  } catch (e: any) {
    return err(400, "bad_quota", e?.message || "quota rejected");
  }
}
