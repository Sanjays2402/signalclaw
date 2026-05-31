// Edge middleware: mint and propagate X-Request-Id on every request, and
// emit one structured JSON log line per response so operators can stitch
// dashboard traffic with audit-log entries (which also carry request_id).
//
// We deliberately do NOT do metrics here. Middleware is edge-runtime, which
// cannot share in-memory counters with the Node route handlers that actually
// serve /api/v1/* (those isolates differ). Metrics are observed inside the
// per-route rate-limit guard and the health/metrics routes themselves.
import { NextRequest, NextResponse } from "next/server";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mintId(): string {
  // crypto.randomUUID is available in the edge runtime.
  return crypto.randomUUID();
}

function safeIncomingId(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 128) return null;
  // Accept a UUID or any sane opaque token from the caller (e.g. trace-id).
  if (UUID_V4.test(s)) return s;
  if (/^[A-Za-z0-9._:\-]+$/.test(s)) return s;
  return null;
}

export function middleware(req: NextRequest) {
  const incoming =
    safeIncomingId(req.headers.get("x-request-id")) ||
    safeIncomingId(req.headers.get("x-correlation-id"));
  const requestId = incoming || mintId();

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);

  // SOC2 / pentest baseline security headers, mirrored from the
  // Python API SecurityHeadersMiddleware so a browser hitting either
  // surface gets identical guarantees. Edge runtime safe (string
  // header writes only). Disable on plain-HTTP local dev with
  // NEXT_PUBLIC_SECURITY_HEADERS_ENABLED=0.
  if (process.env.NEXT_PUBLIC_SECURITY_HEADERS_ENABLED !== "0") {
    const hstsAge = process.env.NEXT_PUBLIC_HSTS_MAX_AGE ?? "31536000";
    if (Number(hstsAge) > 0) {
      res.headers.set(
        "Strict-Transport-Security",
        `max-age=${hstsAge}; includeSubDomains`,
      );
    }
    res.headers.set("X-Content-Type-Options", "nosniff");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set(
      "Permissions-Policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), " +
        "magnetometer=(), microphone=(), payment=(), usb=()",
    );
    res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    res.headers.set("Cross-Origin-Resource-Policy", "same-site");
  }
  return res;
}

export const config = {
  // Cover everything except the Next internals so request-id is universal.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
