// Plain Node test for correlation URL helpers.
// Run with: node --experimental-strip-types --test tests/correlationUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "correlationUrl.ts"));

test("parseCorrelationUrlState returns defaults for empty query", () => {
  const s = mod.parseCorrelationUrlState("");
  assert.equal(s.window, 60);
  assert.equal(s.threshold, 0.7);
});

test("parseCorrelationUrlState reads window and threshold", () => {
  const s = mod.parseCorrelationUrlState("window=120&threshold=0.85");
  assert.equal(s.window, 120);
  assert.equal(s.threshold, 0.85);
});

test("parseCorrelationUrlState clamps out-of-range values", () => {
  const lo = mod.parseCorrelationUrlState("window=1&threshold=0.01");
  assert.equal(lo.window, 5);
  assert.equal(lo.threshold, 0.1);
  const hi = mod.parseCorrelationUrlState("window=9999&threshold=2");
  assert.equal(hi.window, 500);
  assert.equal(hi.threshold, 0.99);
});

test("parseCorrelationUrlState falls back to defaults on garbage", () => {
  const s = mod.parseCorrelationUrlState("window=abc&threshold=xyz");
  assert.equal(s.window, 60);
  assert.equal(s.threshold, 0.7);
});

test("parseCorrelationUrlState truncates fractional windows", () => {
  const s = mod.parseCorrelationUrlState("window=42.9");
  assert.equal(s.window, 42);
});

test("serializeCorrelationUrlState omits defaults entirely", () => {
  const qs = mod.serializeCorrelationUrlState({ window: 60, threshold: 0.7 });
  assert.equal(qs, "");
});

test("serializeCorrelationUrlState includes only the customized knob", () => {
  assert.equal(
    mod.serializeCorrelationUrlState({ window: 120, threshold: 0.7 }),
    "window=120",
  );
  assert.equal(
    mod.serializeCorrelationUrlState({ window: 60, threshold: 0.85 }),
    "threshold=0.85",
  );
});

test("serializeCorrelationUrlState rounds threshold to two decimals", () => {
  const qs = mod.serializeCorrelationUrlState({ window: 60, threshold: 0.8567 });
  assert.equal(qs, "threshold=0.86");
});

test("round trip through URLSearchParams is stable", () => {
  const original = { window: 90, threshold: 0.55 };
  const qs = mod.serializeCorrelationUrlState(original);
  const parsed = mod.parseCorrelationUrlState(qs);
  assert.deepEqual(parsed, original);
});

test("parseCorrelationUrlState accepts URLSearchParams directly", () => {
  const sp = new URLSearchParams();
  sp.set("window", "30");
  sp.set("threshold", "0.5");
  const s = mod.parseCorrelationUrlState(sp);
  assert.equal(s.window, 30);
  assert.equal(s.threshold, 0.5);
});
