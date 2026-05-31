import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { runCheck } from "@/lib/alertStore";

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
  const key = await authenticate(extractKey(req));
  if (!key) return err(401, "unauthorized", "missing or invalid api key");
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    return err(403, "forbidden", "trade scope required to run alert checks");
  }

  let body: any = {};
  const text = await req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return err(400, "bad_json", "request body must be valid JSON");
    }
  }

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

  const result = await runCheck(prices);
  return NextResponse.json(result);
}
