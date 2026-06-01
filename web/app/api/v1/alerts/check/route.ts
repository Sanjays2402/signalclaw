import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { runCheck } from "@/lib/alertStore";
import { isDryRun, dryRunResponse } from "@/lib/dryRun";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

// POST /v1/alerts/check  (trade or admin scope)
// Body: { prices?: { TICKER: number } }
// Evaluates every armed alert against either supplied prices or the built-in
// quote source. Returns the alerts that fired and the quotes used so callers
// can wire this into their own scheduler.
export async function POST(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/check", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/alerts/check", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to run alert checks");
  }
  await recordAuditEvent({ req, route: "/api/v1/alerts/check", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/alerts/check", async () => {
  const raw = await req.text();
  return withIdempotency(req, key, "/api/v1/alerts/check", raw, async ({ body: parsed }) => {

  const body: any = parsed ?? {};

  let prices: Record<string, number> | undefined;
  if (body && body.prices != null) {
    if (typeof body.prices !== "object" || Array.isArray(body.prices)) {
      return err(400, "bad_prices", "prices must be an object of ticker to number");
    }
    prices = {};
    for (const [k, v] of Object.entries(body.prices)) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        return err(400, "bad_price", `price for ${k} must be a positive number`);
      }
      prices[String(k).toUpperCase()] = n;
    }
  }

  const dry = isDryRun(req, body);
  const result = await runCheck(prices, { dryRun: dry, ownerId: key.id });
  if (dry) {
    const effect = {
      action: "evaluate",
      resource: "alert_check",
      id: null,
      preview: { hits: result.hits, checked: result.checked, quotes: result.quotes },
    };
    await recordAuditEvent({ req, route: "/api/v1/alerts/check", method: req.method, status: 200, key, reason: "dry_run", details: { hit_count: result.hits.length } });
    return dryRunResponse(effect, { status: 200 });
  }
  return NextResponse.json(result);

  });
  });
}
