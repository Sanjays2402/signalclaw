// OpenAPI spec tests. Run with:
//   node --experimental-strip-types --test tests/openapiSpec.test.mjs
//
// Two purposes:
//   1) Validate the spec is structurally sound OpenAPI 3.1.
//   2) Prove the spec does not drift from the route table: every documented
//      path must have a matching route.ts file under app/api/v1/.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "openapiSpec.ts"));

function oasPathToRouteFile(p) {
  // Reverse the {param} -> [param] mapping, then resolve to route.ts.
  const segs = p.replace(/^\/api\/v1\//, "").split("/").filter(Boolean);
  const fsSegs = segs.map((s) => s.replace(/^\{(.+)\}$/, "[$1]"));
  return path.join(repoRoot, "app", "api", "v1", ...fsSegs, "route.ts");
}

test("buildSpec produces a valid OpenAPI 3.1 envelope", () => {
  const spec = mod.buildSpec();
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(typeof spec.info, "object");
  assert.ok(spec.info.title);
  assert.ok(spec.info.version);
  assert.ok(spec.paths && typeof spec.paths === "object");
  assert.ok(spec.components?.securitySchemes?.bearerAuth);
  assert.ok(spec.components?.securitySchemes?.apiKeyHeader);
});

test("every declared path has a route handler on disk", async () => {
  for (const p of mod.PATHS) {
    const oas = p.path.replace(/\[([^\]]+)\]/g, "{$1}");
    const file = oasPathToRouteFile(oas);
    let ok = true;
    try { await fs.access(file); } catch { ok = false; }
    assert.ok(ok, `missing route file for ${p.path} (expected ${file})`);
  }
});

test("every operation declares the documented responses", () => {
  const spec = mod.buildSpec();
  for (const [pth, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      assert.ok(op.operationId, `${method.toUpperCase()} ${pth} missing operationId`);
      assert.ok(op.responses?.["200"], `${method.toUpperCase()} ${pth} missing 200`);
      assert.ok(op.responses?.["401"], `${method.toUpperCase()} ${pth} missing 401`);
      assert.ok(op.responses?.["403"], `${method.toUpperCase()} ${pth} missing 403`);
      assert.ok(op.responses?.["429"], `${method.toUpperCase()} ${pth} missing 429`);
      const rl = op.responses["429"].headers || {};
      assert.ok(rl["X-RateLimit-Limit"], `${method.toUpperCase()} ${pth} 429 missing X-RateLimit-Limit`);
      assert.ok(rl["Retry-After"], `${method.toUpperCase()} ${pth} 429 missing Retry-After`);
    }
  }
});

test("operationIds are unique", () => {
  const spec = mod.buildSpec();
  const seen = new Set();
  for (const item of Object.values(spec.paths)) {
    for (const op of Object.values(item)) {
      assert.ok(!seen.has(op.operationId), `duplicate operationId: ${op.operationId}`);
      seen.add(op.operationId);
    }
  }
});

test("$ref targets resolve to declared component schemas", () => {
  const spec = mod.buildSpec();
  const schemas = spec.components.schemas;
  const refs = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const [k, val] of Object.entries(v)) {
      if (k === "$ref" && typeof val === "string") refs.push(val);
      else walk(val);
    }
  };
  walk(spec.paths);
  walk(spec.components.schemas);
  for (const r of refs) {
    const m = r.match(/^#\/components\/schemas\/(.+)$/);
    assert.ok(m, `non-component $ref: ${r}`);
    assert.ok(schemas[m[1]], `unknown schema: ${m[1]}`);
  }
});

test("servers default is set", () => {
  const spec = mod.buildSpec();
  assert.ok(Array.isArray(spec.servers));
  assert.ok(spec.servers.length >= 1);
  const withOrigin = mod.buildSpec("https://example.test");
  assert.equal(withOrigin.servers[0].url, "https://example.test");
});
