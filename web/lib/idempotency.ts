// Idempotency-Key wrapper for v1 mutating endpoints.
//
// Usage inside a route handler, *after* auth + scope checks have passed and
// inside the rate-limit guard's callback:
//
//   return enforceRateLimit(req, key, "/api/v1/alerts", async () => {
//     const raw = await req.text(); // body parsed once, here
//     return withIdempotency(req, key, "/api/v1/alerts", raw, async (body) => {
//       // body is the parsed JSON object (or null when raw is empty)
//       // return a NextResponse as you would normally
//     });
//   });
//
// On replay, the wrapper returns the original 2xx response (status + body +
// content-type) with `Idempotent-Replayed: true` and the original
// `Idempotency-Key` echoed back. On conflict (same key, different request)
// it returns 409 without invoking the handler. On miss, the handler runs
// and any 2xx response is cached for 24h.

import { NextResponse } from "next/server.js";
import type { StoredKey } from "./keyStore";
import {
  fingerprint,
  lookup,
  store,
  validateHeader,
  type IdempotencyRecord,
} from "./idempotencyStore.ts";
import { recordAuditEvent } from "./auditStore.ts";

const REPLAY_HEADER = "Idempotent-Replayed";
const KEY_HEADER = "Idempotency-Key";

function err(status: number, code: string, message: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: { code, message, ...(extra ?? {}) } }, { status });
}

export type IdempotencyHandlerArgs = {
  // Parsed JSON body or null when the raw body was empty. Handlers that
  // require a body should treat null as "bad_body".
  body: any;
  // Raw body string, in case the handler wants to recompute things.
  raw: string;
};

export async function withIdempotency(
  req: Request,
  key: StoredKey,
  route: string,
  raw: string,
  handler: (args: IdempotencyHandlerArgs) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const method = (req as any).method ?? "POST";
  const headerRaw = req.headers.get(KEY_HEADER) ?? req.headers.get(KEY_HEADER.toLowerCase());
  const requestId = req.headers.get("x-request-id") || undefined;

  // Parse body once. Empty body is allowed (DELETE may carry none).
  let body: any = null;
  if (raw && raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return err(400, "bad_json", "request body must be valid JSON");
    }
  }

  // No header? Pass through; this preserves existing behaviour for callers
  // that don't opt in.
  if (!headerRaw) {
    return handler({ body, raw });
  }

  const v = validateHeader(headerRaw);
  if (!v.ok) {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 400,
      key,
      reason: `idempotency:bad_header:${v.code}`,
    }).catch(() => {});
    return err(400, "bad_idempotency_key", v.message);
  }

  const fp = fingerprint(method, route, raw);
  const decision = await lookup(key.id, v.value, fp);

  if (decision.kind === "conflict") {
    await recordAuditEvent({
      req,
      route,
      method,
      status: 409,
      key,
      reason: "idempotency:conflict",
      details: { idempotency_key: v.value },
    }).catch(() => {});
    const res = err(
      409,
      "idempotency_conflict",
      "this Idempotency-Key was used with a different request body or path",
      { idempotency_key: v.value, first_seen_at: decision.record.created_at },
    );
    res.headers.set(KEY_HEADER, v.value);
    if (requestId) res.headers.set("x-request-id", requestId);
    return res;
  }

  if (decision.kind === "hit") {
    const rec = decision.record;
    const res = new NextResponse(rec.body, {
      status: rec.status,
      headers: { "content-type": rec.content_type },
    });
    for (const [k, vv] of Object.entries(rec.cached_headers ?? {})) {
      res.headers.set(k, vv);
    }
    res.headers.set(REPLAY_HEADER, "true");
    res.headers.set(KEY_HEADER, v.value);
    if (requestId) res.headers.set("x-request-id", requestId);
    await recordAuditEvent({
      req,
      route,
      method,
      status: rec.status,
      key,
      reason: "idempotency:replay",
      details: { idempotency_key: v.value, first_seen_at: rec.created_at },
    }).catch(() => {});
    return res;
  }

  // Miss: run the handler, then cache if we got a 2xx response.
  const res = await handler({ body, raw });
  res.headers.set(KEY_HEADER, v.value);
  res.headers.set(REPLAY_HEADER, "false");

  if (res.status >= 200 && res.status < 300) {
    try {
      const cloned = res.clone();
      const responseBody = await cloned.text();
      const contentType = res.headers.get("content-type") || "application/json";
      // Cache a small whitelist of safe headers so replays look identical.
      const cachedHeaders: Record<string, string> = {};
      const safe = ["location", "etag", "x-resource-id"];
      for (const h of safe) {
        const val = res.headers.get(h);
        if (val) cachedHeaders[h] = val;
      }
      const now = new Date();
      const rec: IdempotencyRecord = {
        key_id: key.id,
        header: v.value,
        fingerprint: fp,
        status: res.status,
        body: responseBody,
        content_type: contentType,
        cached_headers: cachedHeaders,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
      await store(rec);
    } catch {
      // best-effort; failure to cache does not affect the response
    }
  }

  return res;
}
