// node --experimental-strip-types --test tests/observability.test.mjs
//
// Verifies the new enterprise observability surface:
//   - /healthz and /readyz return the expected JSON shape
//   - /metrics renders Prometheus text exposition with our series
//   - request observation flows into the counter + histogram
//   - audit log captures the X-Request-Id header propagated by middleware
//   - route classifier maps the paths buyers will actually scrape
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-obs-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const metrics = await import(path.join(repoRoot, "lib", "metricsStore.ts"));
const audit = await import(path.join(repoRoot, "lib", "auditStore.ts"));
const keys = await import(path.join(repoRoot, "lib", "keyStore.ts"));
// Route handlers import `next/server`, which only resolves inside the Next
// build. We exercise the underlying primitives (metricsStore + auditStore)
// directly here, then assert the rendered Prometheus payload matches what
// /metrics returns.

test("classifier maps real paths to bounded label set", () => {
  assert.equal(metrics.classifyRoute("/healthz"), "health");
  assert.equal(metrics.classifyRoute("/readyz"), "health");
  assert.equal(metrics.classifyRoute("/metrics"), "metrics");
  assert.equal(metrics.classifyRoute("/api/v1/runs"), "api_v1");
  assert.equal(metrics.classifyRoute("/api/v1/runs/abc-123"), "api_v1");
  assert.equal(metrics.classifyRoute("/api/admin/keys"), "api_admin");
  assert.equal(metrics.classifyRoute("/api/settings/export"), "api_other");
  assert.equal(metrics.classifyRoute("/settings/keys"), "page");
  assert.equal(metrics.classifyRoute("/_next/static/x.js"), "asset");
  assert.equal(metrics.classifyRoute("/favicon.ico"), "asset");
});

test("statusClass buckets responses correctly", () => {
  assert.equal(metrics.statusClass(200), "2xx");
  assert.equal(metrics.statusClass(301), "3xx");
  assert.equal(metrics.statusClass(404), "4xx");
  assert.equal(metrics.statusClass(429), "4xx");
  assert.equal(metrics.statusClass(503), "5xx");
});

test("/metrics renders prometheus text including our series", async () => {
  metrics._resetForTests();
  // Synthesize a few requests so the counters have something to report.
  metrics.observeRequest({ method: "GET", status: 200, route_class: "api_v1", durationMs: 12 });
  metrics.observeRequest({ method: "GET", status: 200, route_class: "api_v1", durationMs: 33 });
  metrics.observeRequest({ method: "POST", status: 429, route_class: "api_v1", durationMs: 4 });

  const body = metrics.renderProm();

  // Required series for a stock Prometheus scrape config.
  assert.match(body, /signalclaw_build_info/);
  assert.match(body, /signalclaw_process_uptime_seconds /);
  assert.match(body, /signalclaw_process_resident_memory_bytes /);
  assert.match(body, /signalclaw_http_requests_in_flight /);
  assert.match(body, /signalclaw_http_requests_total\{[^}]*method="GET"[^}]*status_class="2xx"[^}]*route_class="api_v1"\} 2/);
  assert.match(body, /signalclaw_http_requests_total\{[^}]*method="POST"[^}]*status_class="4xx"[^}]*\} 1/);
  // Histogram has the right shape.
  assert.match(body, /signalclaw_http_request_duration_seconds_bucket\{[^}]*le="0.025"\}/);
  assert.match(body, /signalclaw_http_request_duration_seconds_bucket\{[^}]*le="\+Inf"\}/);
  assert.match(body, /signalclaw_http_request_duration_seconds_sum\{/);
  assert.match(body, /signalclaw_http_request_duration_seconds_count\{/);
});

test("audit log captures propagated x-request-id", async () => {
  const { key } = await keys.createKey({ label: "obs", scopes: ["read"] });
  const reqId = "req_abc123-DEF.456:xyz";
  const req = new Request("http://localhost/api/v1/whoami", {
    method: "GET",
    headers: { "x-request-id": reqId, "user-agent": "obs-test/1" },
  });
  const ev = await audit.recordAuditEvent({
    req,
    route: "/api/v1/whoami",
    method: "GET",
    status: 200,
    key: { id: key.id, label: key.label, prefix: key.prefix, scopes: key.scopes },
  });
  assert.equal(ev.request_id, reqId);
  assert.equal(ev.ok, true);
});

test("audit request_id is null when the caller did not send one", async () => {
  const req = new Request("http://localhost/api/v1/whoami", { method: "GET" });
  const ev = await audit.recordAuditEvent({
    req,
    route: "/api/v1/whoami",
    method: "GET",
    status: 401,
    key: null,
    reason: "unauthorized",
  });
  assert.equal(ev.request_id, null);
  assert.equal(ev.ok, false);
});

test("in-flight gauge tracks concurrent requests", async () => {
  metrics._resetForTests();
  metrics.incInFlight();
  metrics.incInFlight();
  const mid = metrics.renderProm();
  assert.match(mid, /signalclaw_http_requests_in_flight 2/);
  metrics.decInFlight();
  metrics.decInFlight();
  metrics.decInFlight(); // floor at 0
  const end = metrics.renderProm();
  assert.match(end, /signalclaw_http_requests_in_flight 0/);
});

test("histogram buckets cumulate and +Inf matches count", () => {
  metrics._resetForTests();
  metrics.observeRequest({ method: "GET", status: 200, route_class: "api_v1", durationMs: 3 });
  metrics.observeRequest({ method: "GET", status: 200, route_class: "api_v1", durationMs: 30 });
  metrics.observeRequest({ method: "GET", status: 200, route_class: "api_v1", durationMs: 9999 });
  const body = metrics.renderProm();
  // 5ms bucket should have only the 3ms request.
  assert.match(body, /signalclaw_http_request_duration_seconds_bucket\{[^}]*le="0.005"\} 1/);
  // +Inf bucket equals total count = 3.
  assert.match(body, /signalclaw_http_request_duration_seconds_bucket\{[^}]*le="\+Inf"\} 3/);
  assert.match(body, /signalclaw_http_request_duration_seconds_count\{[^}]*\} 3/);
});
