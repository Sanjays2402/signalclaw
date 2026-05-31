// Unit tests for compare helpers.
// Run with: node --experimental-strip-types --test tests/compare.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "compare.ts"));

test("regimeMix returns zeros when total is zero", () => {
  const { total, mix } = mod.regimeMix({ counts: { bull: 0, chop: 0, bear: 0, crash: 0 } });
  assert.equal(total, 0);
  assert.deepEqual(mix, { bull: 0, chop: 0, bear: 0, crash: 0 });
});

test("regimeMix normalizes shares to sum to 1", () => {
  const { total, mix } = mod.regimeMix({ counts: { bull: 3, chop: 1, bear: 0, crash: 0 } });
  assert.equal(total, 4);
  assert.equal(mix.bull, 0.75);
  assert.equal(mix.chop, 0.25);
  const sum = mix.bull + mix.chop + mix.bear + mix.crash;
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("pctChange handles empty, single, and normal series", () => {
  assert.equal(mod.pctChange([]), null);
  assert.equal(mod.pctChange([100]), null);
  assert.equal(mod.pctChange([100, 110]), 0.1);
  assert.equal(mod.pctChange([100, 90]), -0.1);
  assert.equal(mod.pctChange([0, 50]), null); // base zero guard
});

test("mixDiff returns b minus a per regime", () => {
  const a = { bull: 0.5, chop: 0.5, bear: 0, crash: 0 };
  const b = { bull: 0.2, chop: 0.6, bear: 0.1, crash: 0.1 };
  const d = mod.mixDiff(a, b);
  assert.ok(Math.abs(d.bull - -0.3) < 1e-9);
  assert.ok(Math.abs(d.chop - 0.1) < 1e-9);
  assert.equal(d.bear, 0.1);
  assert.equal(d.crash, 0.1);
});

test("isValidRunId enforces charset and length bounds", () => {
  assert.equal(mod.isValidRunId("abc123_-XYZ"), true);
  assert.equal(mod.isValidRunId(""), false);
  assert.equal(mod.isValidRunId("short"), false); // 5 chars
  assert.equal(mod.isValidRunId("a".repeat(65)), false);
  assert.equal(mod.isValidRunId("../etc/passwd"), false);
  assert.equal(mod.isValidRunId(null), false);
  assert.equal(mod.isValidRunId(123), false);
});
