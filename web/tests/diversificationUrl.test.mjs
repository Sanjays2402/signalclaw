// Plain Node test for diversification URL helpers.
// Run with: node --experimental-strip-types --test tests/diversificationUrl.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "diversificationUrl.ts"));

test("parseDiversificationUrlState returns defaults for empty query", () => {
  const s = mod.parseDiversificationUrlState("");
  assert.equal(s.window, 60);
  assert.equal(s.threshold, 0.7);
});

test("parseDiversificationUrlState reads window and threshold", () => {
  const s = mod.parseDiversificationUrlState("window=120&threshold=0.85");
  assert.equal(s.window, 120);
  assert.equal(s.threshold, 0.85);
});

test("parseDiversificationUrlState clamps out-of-range values", () => {
  const lo = mod.parseDiversificationUrlState("window=1&threshold=-1");
  assert.equal(lo.window, 10);
  assert.equal(lo.threshold, 0);
  const hi = mod.parseDiversificationUrlState("window=9999&threshold=2");
  assert.equal(hi.window, 500);
  assert.equal(hi.threshold, 1);
});

test("parseDiversificationUrlState falls back to defaults on garbage", () => {
  const s = mod.parseDiversificationUrlState("window=abc&threshold=xyz");
  assert.equal(s.window, 60);
  assert.equal(s.threshold, 0.7);
});

test("parseDiversificationUrlState truncates fractional windows", () => {
  const s = mod.parseDiversificationUrlState("window=42.9");
  assert.equal(s.window, 42);
});

test("serializeDiversificationUrlState omits defaults entirely", () => {
  const qs = mod.serializeDiversificationUrlState({ window: 60, threshold: 0.7 });
  assert.equal(qs, "");
});

test("serializeDiversificationUrlState includes only the customized knob", () => {
  assert.equal(
    mod.serializeDiversificationUrlState({ window: 120, threshold: 0.7 }),
    "window=120",
  );
  assert.equal(
    mod.serializeDiversificationUrlState({ window: 60, threshold: 0.85 }),
    "threshold=0.85",
  );
});

test("serializeDiversificationUrlState rounds threshold to two decimals", () => {
  const qs = mod.serializeDiversificationUrlState({ window: 60, threshold: 0.8567 });
  assert.equal(qs, "threshold=0.86");
});

test("round trip through URLSearchParams is stable", () => {
  const original = { window: 90, threshold: 0.55 };
  const qs = mod.serializeDiversificationUrlState(original);
  const parsed = mod.parseDiversificationUrlState(qs);
  assert.deepEqual(parsed, original);
});

test("parseDiversificationUrlState accepts URLSearchParams directly", () => {
  const sp = new URLSearchParams();
  sp.set("window", "30");
  sp.set("threshold", "0.5");
  const s = mod.parseDiversificationUrlState(sp);
  assert.equal(s.window, 30);
  assert.equal(s.threshold, 0.5);
});
