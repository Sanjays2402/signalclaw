// Edge middleware: mint and propagate X-Request-Id on every request, and
// emit one structured JSON log line per response so operators can stitch
// dashboard traffic with audit-log entries (which also carry request_id).
//
// We deliberately do NOT do metrics here. Middleware is edge-runtime, which
// cannot share in-memory counters with the Node route handlers that actually
// serve /api/v1/* (those isolates differ). Metrics are observed inside the
// per-route rate-limit guard and the health/metrics routes themselves.
import { NextRequest, NextResponse } from "next/server";
import { getPolicy, decide, applyCors } from "@/lib/corsPolicy";

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

  // CORS: only for `/api/*` (the dashboard's own pages don't need it and
  // would only attract reflected XSS noise). Preflight gets short-circuited
  // with 204; real requests fall through with the right ACAO headers.
  const pathname = req.nextUrl.pathname;
  const isApi = pathname.startsWith("/api/");
  const origin = req.headers.get("origin");
  let corsDecision: ReturnType<typeof decide> | null = null;
  if (isApi && origin) {
    corsDecision = decide(origin, getPolicy());
  }

  if (isApi && req.method === "OPTIONS") {
    // Preflight: respond with 204, no body. ACAO headers only if allowed.
    const pre = new NextResponse(null, { status: 204 });
    pre.headers.set("x-request-id", requestId);
    if (corsDecision) applyCors(pre.headers, corsDecision, true);
    else {
      // Still set Vary: Origin so caches don't poison.
      pre.headers.set("Vary", "Origin");
    }
    return pre;
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  if (isApi && corsDecision) {
    applyCors(res.headers, corsDecision, false);
  } else if (isApi) {
    const v = new Set(
      (res.headers.get("Vary") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    v.add("Origin");
    res.headers.set("Vary", Array.from(v).join(", "));
  }

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

    // Content-Security-Policy. Env-driven so the edge middleware stays
    // filesystem-free. Operators can preview with
    // `SIGNALCLAW_CSP_MODE=report` and flip to `enforce` once the
    // /api/csp-report log is quiet. The admin UI at /settings/security/csp
    // documents the current effective values and persists workspace
    // overrides that take effect on next deploy.
    const cspMode = (process.env.SIGNALCLAW_CSP_MODE || "").toLowerCase();
    if (cspMode === "report" || cspMode === "report-only" || cspMode === "enforce") {
      const extraRaw = process.env.SIGNALCLAW_CSP_EXTRA_HOSTS || "";
      const extras = extraRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^(?:'(?:self|none|unsafe-inline|unsafe-eval|strict-dynamic|sha(?:256|384|512)-[A-Za-z0-9+/=]+)'|(?:data|https?|wss?):(?:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/\-]*)?)?|(?:\*\.)?[a-z0-9.-]+(?::\d+)?)$/i.test(s))
        .join(" ");
      const join = (b: string) => (extras ? `${b} ${extras}` : b);
      const reportOff = process.env.SIGNALCLAW_CSP_REPORT_DISABLED === "1";
      const parts = [
        "default-src 'self'",
        join("script-src 'self'"),
        "style-src 'self' 'unsafe-inline'",
        join("img-src 'self' data: blob:"),
        join("connect-src 'self'"),
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
        "worker-src 'self' blob:",
      ];
      if (!reportOff) parts.push("report-uri /api/csp-report");
      const header = parts.join("; ");
      const name = cspMode === "enforce"
        ? "Content-Security-Policy"
        : "Content-Security-Policy-Report-Only";
      res.headers.set(name, header);
    }
  }
  return res;
}

export const config = {
  // Cover everything except the Next internals so request-id is universal.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
