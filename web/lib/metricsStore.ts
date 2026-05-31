// Process-local Prometheus metrics for the Next.js dashboard.
//
// Zero-dependency: emits Prometheus text exposition format directly.
// Counters live for the lifetime of the Node process. On serverless
// platforms (e.g. Vercel functions) each isolate keeps its own series,
// which is the standard tradeoff for in-process metrics. For long-lived
// `next start` or container deploys this is exactly what /metrics scrapers
// expect.
//
// We deliberately keep label cardinality tiny:
//   - method  (GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD)
//   - status_class  (2xx/3xx/4xx/5xx)
//   - route_class  (api_v1 / api_admin / api_other / page / asset / health / metrics)
// Full route paths are intentionally NOT a label to avoid unbounded series
// from user-generated ids in URLs.

export type RouteClass =
  | "api_v1"
  | "api_admin"
  | "api_other"
  | "page"
  | "asset"
  | "health"
  | "metrics";

export function classifyRoute(pathname: string): RouteClass {
  if (pathname === "/metrics") return "metrics";
  if (pathname === "/healthz" || pathname === "/readyz") return "health";
  if (pathname.startsWith("/api/v1/")) return "api_v1";
  if (pathname.startsWith("/api/admin/")) return "api_admin";
  if (pathname.startsWith("/api/")) return "api_other";
  if (pathname.startsWith("/_next/") || /\.[a-z0-9]+$/i.test(pathname))
    return "asset";
  return "page";
}

export function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

type Key = string;

type Histogram = {
  buckets: number[]; // upper bounds, ms
  counts: number[]; // cumulative? no, raw per-bucket; we cumulate on render
  sum: number;
  count: number;
};

type Store = {
  startedAt: number;
  reqTotal: Map<Key, number>;
  reqInFlight: number;
  reqHist: Map<Key, Histogram>;
};

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

const g = globalThis as unknown as { __signalclawMetrics?: Store };

function store(): Store {
  if (!g.__signalclawMetrics) {
    g.__signalclawMetrics = {
      startedAt: Date.now(),
      reqTotal: new Map(),
      reqInFlight: 0,
      reqHist: new Map(),
    };
  }
  return g.__signalclawMetrics;
}

function labelKey(
  method: string,
  status_class: string,
  route_class: RouteClass,
): Key {
  return `${method}|${status_class}|${route_class}`;
}

export function incInFlight(): void {
  store().reqInFlight += 1;
}

export function decInFlight(): void {
  const s = store();
  s.reqInFlight = Math.max(0, s.reqInFlight - 1);
}

export function observeRequest(opts: {
  method: string;
  status: number;
  route_class: RouteClass;
  durationMs: number;
}): void {
  const s = store();
  const m = (opts.method || "GET").toUpperCase();
  const sc = statusClass(opts.status);
  const k = labelKey(m, sc, opts.route_class);
  s.reqTotal.set(k, (s.reqTotal.get(k) ?? 0) + 1);
  let h = s.reqHist.get(k);
  if (!h) {
    h = { buckets: BUCKETS_MS, counts: new Array(BUCKETS_MS.length).fill(0), sum: 0, count: 0 };
    s.reqHist.set(k, h);
  }
  const d = Math.max(0, opts.durationMs);
  let placed = false;
  for (let i = 0; i < h.buckets.length; i++) {
    if (d <= h.buckets[i]!) {
      h.counts[i]! += 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    // +Inf bucket is implicit; we still count it in total.
  }
  h.sum += d / 1000; // seconds, per Prometheus convention
  h.count += 1;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function parseKey(k: Key): { method: string; status_class: string; route_class: string } {
  const [method, status_class, route_class] = k.split("|");
  return {
    method: method ?? "",
    status_class: status_class ?? "",
    route_class: route_class ?? "",
  };
}

export function renderProm(): string {
  const s = store();
  const lines: string[] = [];

  lines.push("# HELP signalclaw_build_info Build metadata for the dashboard.");
  lines.push("# TYPE signalclaw_build_info gauge");
  lines.push(
    `signalclaw_build_info{version="${escapeLabel(process.env.npm_package_version || "0.0.0")}",node="${escapeLabel(process.version)}"} 1`,
  );

  lines.push("# HELP signalclaw_process_uptime_seconds Seconds since process start.");
  lines.push("# TYPE signalclaw_process_uptime_seconds gauge");
  lines.push(`signalclaw_process_uptime_seconds ${((Date.now() - s.startedAt) / 1000).toFixed(3)}`);

  const mem = process.memoryUsage();
  lines.push("# HELP signalclaw_process_resident_memory_bytes Resident set size in bytes.");
  lines.push("# TYPE signalclaw_process_resident_memory_bytes gauge");
  lines.push(`signalclaw_process_resident_memory_bytes ${mem.rss}`);
  lines.push("# HELP signalclaw_process_heap_used_bytes Heap used in bytes.");
  lines.push("# TYPE signalclaw_process_heap_used_bytes gauge");
  lines.push(`signalclaw_process_heap_used_bytes ${mem.heapUsed}`);

  lines.push("# HELP signalclaw_http_requests_in_flight In-flight HTTP requests.");
  lines.push("# TYPE signalclaw_http_requests_in_flight gauge");
  lines.push(`signalclaw_http_requests_in_flight ${s.reqInFlight}`);

  lines.push("# HELP signalclaw_http_requests_total HTTP requests served.");
  lines.push("# TYPE signalclaw_http_requests_total counter");
  for (const [k, v] of s.reqTotal) {
    const p = parseKey(k);
    lines.push(
      `signalclaw_http_requests_total{method="${escapeLabel(p.method)}",status_class="${escapeLabel(p.status_class)}",route_class="${escapeLabel(p.route_class)}"} ${v}`,
    );
  }

  lines.push("# HELP signalclaw_http_request_duration_seconds HTTP request duration in seconds.");
  lines.push("# TYPE signalclaw_http_request_duration_seconds histogram");
  for (const [k, h] of s.reqHist) {
    const p = parseKey(k);
    const labels = `method="${escapeLabel(p.method)}",status_class="${escapeLabel(p.status_class)}",route_class="${escapeLabel(p.route_class)}"`;
    let cum = 0;
    for (let i = 0; i < h.buckets.length; i++) {
      cum += h.counts[i]!;
      lines.push(
        `signalclaw_http_request_duration_seconds_bucket{${labels},le="${(h.buckets[i]! / 1000).toFixed(3)}"} ${cum}`,
      );
    }
    lines.push(
      `signalclaw_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`,
    );
    lines.push(`signalclaw_http_request_duration_seconds_sum{${labels}} ${h.sum.toFixed(6)}`);
    lines.push(`signalclaw_http_request_duration_seconds_count{${labels}} ${h.count}`);
  }

  return lines.join("\n") + "\n";
}

// Test helper. Not exported through the public route.
export function _resetForTests(): void {
  const s = store();
  s.reqTotal.clear();
  s.reqHist.clear();
  s.reqInFlight = 0;
  s.startedAt = Date.now();
}
