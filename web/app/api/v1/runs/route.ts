import { NextRequest, NextResponse } from "next/server";
import { authenticate, extractKey } from "@/lib/keyStore";
import { enforceRateLimit } from "@/lib/v1Guard";
import { recordAuditEvent } from "@/lib/auditStore";
import { queryRuns, createRun, normalizeTags } from "@/lib/runStore";
import { ownerFilterForKey } from "@/lib/runAcl";
import { classifyRegime } from "@/lib/regimeClassify";
import { recordSafe } from "@/lib/activityStore";
import { dispatchEvents, type PickEvent } from "@/lib/webhookStore";
import { isDryRun, dryRunResponse } from "@/lib/dryRun";
import { withIdempotency } from "@/lib/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function parseIntParam(v: string | null, fallback: number): number {
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// GET /v1/runs?q=&ticker=&regime=&limit=&offset=
// Auth: Authorization: Bearer <key>  (read scope)
// Returns a slim public view; no internal hashes or raw payloads.
export async function GET(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("read") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 403, key, reason: "forbidden:read-required" });
    return err(403, "forbidden", "read scope required");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs", async () => {

  const sp = req.nextUrl.searchParams;
  const q = sp.get("q") ?? "";
  const ticker = sp.get("ticker") ?? "";
  const regime = sp.get("regime") ?? "";
  const pinnedParam = sp.get("pinned");
  const pinnedOnly = pinnedParam === "1" || pinnedParam === "true";
  const limit = Math.min(parseIntParam(sp.get("limit"), 25), 200);
  const offset = Math.max(parseIntParam(sp.get("offset"), 0), 0);

  const { runs, total, limit: appliedLimit, offset: appliedOffset } =
    await queryRuns({ q, ticker, regime, pinned: pinnedOnly ? true : undefined, limit, offset, ownerFilter: ownerFilterForKey(key) });

  const items = runs.map((r) => ({
    id: r.id,
    label: r.label,
    ticker: r.ticker,
    lookback_days: r.lookback_days,
    created_at: r.created_at,
    bars: r.payload.dates.length,
    regime: r.payload.snapshot?.label ?? null,
    confidence: r.payload.snapshot?.confidence ?? null,
    pinned: r.pinned === true,
    share_url: `/r/${r.id}`,
    owner: { key_id: r.created_by_key_id ?? null, key_label: r.created_by_key_label ?? null },
  }));

  return NextResponse.json({
    runs: items,
    total,
    limit: appliedLimit,
    offset: appliedOffset,
    has_more: appliedOffset + items.length < total,
  });

  });
}

// POST /v1/runs
// Auth: Authorization: Bearer <key>  (trade or admin scope)
// Body: { ticker: string, close: number[], dates?: string[YYYY-MM-DD],
//         label?: string, tags?: string[], lookback_days?: number }
// Runs the regime classifier on the caller-supplied price series, persists
// the result, fires webhook events, and returns the saved run id + share url.
export async function POST(req: NextRequest) {
  const key = await authenticate(extractKey(req), { req });
  if (!key) {
    await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 401, key: null, reason: "unauthorized" });
    return err(401, "unauthorized", "missing or invalid api key");
  }
  if (!key.scopes.includes("trade") && !key.scopes.includes("admin")) {
    await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 403, key, reason: "forbidden:trade-required" });
    return err(403, "forbidden", "trade scope required to create runs");
  }
  await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 200, key });
  return enforceRateLimit(req, key, "/api/v1/runs", async () => {
  const raw = await req.text();
  return withIdempotency(req, key, "/api/v1/runs", raw, async ({ body }) => {
  if (!body || typeof body !== "object") {
    return err(400, "bad_body", "request body must be a JSON object");
  }

  const { ticker, close, dates, label, tags, lookback_days } = body;
  const result = classifyRegime({ ticker, close, dates });
  if (!result.ok) {
    return err(400, result.error.code, result.error.message);
  }
  const payload = result.payload;

  const lb =
    typeof lookback_days === "number" && lookback_days >= 1 && lookback_days <= 10000
      ? Math.floor(lookback_days)
      : payload.dates.length;

  const safeLabel =
    typeof label === "string" && label.trim().length > 0
      ? label.trim().slice(0, 80)
      : `${payload.ticker} \u00b7 ${lb}d \u00b7 api`;

  if (isDryRun(req, body)) {
    const effect = {
      action: "create",
      resource: "run",
      id: null,
      preview: {
        label: safeLabel,
        ticker: payload.ticker,
        lookback_days: lb,
        bars: payload.dates.length,
        snapshot: payload.snapshot,
        tags: normalizeTags(tags),
      },
    };
    await recordAuditEvent({ req, route: "/api/v1/runs", method: req.method, status: 200, key, reason: "dry_run", details: { would: effect } });
    return dryRunResponse(effect, { status: 200 });
  }

  const run = await createRun({
    label: safeLabel,
    ticker: payload.ticker,
    lookback_days: lb,
    payload,
    tags: normalizeTags(tags),
    // Stamp ownership so /v1/runs/:id mutations can enforce per-key RBAC.
    created_by_key_id: key.id,
    created_by_key_label: key.label,
  });

  await recordSafe({
    kind: "run.saved",
    title: `API run \u00b7 ${run.ticker}`,
    body: `${run.label} \u00b7 ${payload.snapshot?.label ?? "unknown regime"}`,
    href: `/r/${run.id}`,
  });

  // Fire webhook subscribers (best-effort, errors are swallowed by dispatcher).
  // We translate "new run" into an "entered" pick-style event so existing
  // ticker-scoped subscriptions can match.
  if (payload.snapshot) {
    const ev: PickEvent = {
      kind: "entered",
      ticker: run.ticker,
      as_of: payload.snapshot.as_of,
      new_label: payload.snapshot.label,
      prior_label: null,
      score_delta: null,
    };
    dispatchEvents([ev]).catch(() => {});
  }

  return NextResponse.json(
    {
      id: run.id,
      label: run.label,
      ticker: run.ticker,
      created_at: run.created_at,
      lookback_days: run.lookback_days,
      bars: payload.dates.length,
      snapshot: payload.snapshot,
      tags: run.tags,
      share_url: `/r/${run.id}`,
      owner: { key_id: run.created_by_key_id ?? null, key_label: run.created_by_key_label ?? null },
    },
    { status: 201 },
  );

  });
  });
}
