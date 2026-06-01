import { NextRequest, NextResponse } from "next/server";
import {
  listKeys,
  extractKey,
  authenticate,
} from "@/lib/keyStore";
import { recordAuditEvent } from "@/lib/auditStore";
import {
  summarizeDormancy,
  MAX_DORMANT_WITHIN_DAYS,
  DEFAULT_DORMANT_WITHIN_DAYS,
} from "@/lib/keyDormancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/admin/keys/dormant";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// Read-only sister of /api/admin/keys/expiring. Same local-mode policy:
// in single-user mode (no SIGNALCLAW_ADMIN_KEY) the page is open so the
// operator can see dormancy state before they have minted an admin key;
// in production posture an admin-scoped key is required. Every request
// is audited so a procurement reviewer can prove the watch list is
// access-controlled.
async function requireAdmin(req: NextRequest, method: string): Promise<NextResponse | null> {
  const k = await authenticate(extractKey(req), { req });
  if (!process.env.SIGNALCLAW_ADMIN_KEY) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k, reason: "local-mode" });
    return null;
  }
  if (!k || !k.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: ROUTE, method, status: 403, key: k ?? null, reason: "forbidden:admin-required" });
    return err(403, "forbidden", "admin scope required");
  }
  await recordAuditEvent({ req, route: ROUTE, method, status: 200, key: k });
  return null;
}

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req, "GET");
  if (denied) return denied;

  const raw = new URL(req.url).searchParams.get("within_days");
  let windowDays = DEFAULT_DORMANT_WITHIN_DAYS;
  if (raw !== null && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > MAX_DORMANT_WITHIN_DAYS) {
      return err(
        400,
        "bad_within_days",
        `within_days must be an integer between 1 and ${MAX_DORMANT_WITHIN_DAYS}`,
      );
    }
    windowDays = n;
  }

  const keys = await listKeys();
  const summary = summarizeDormancy(keys, { windowDays });
  return NextResponse.json(summary);
}
