// Plain Node test for nearestTargetDistance helper used by /watchlist.
// Run with: node --experimental-strip-types --test tests/watchlistDistance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "watchlistDistance.ts"));
const { nearestTargetDistance, formatTargetDistancePct } = mod;

test("returns null when there is no close", () => {
  assert.equal(nearestTargetDistance(null, 200, 100), null);
  assert.equal(nearestTargetDistance(undefined, 200, 100), null);
  assert.equal(nearestTargetDistance(0, 200, 100), null);
  assert.equal(nearestTargetDistance(NaN, 200, 100), null);
});

test("returns null when no targets are set", () => {
  assert.equal(nearestTargetDistance(150, null, null), null);
});

test("suppresses sides the close has already breached", () => {
  // Close >= high: high side suppressed, low side remains (210 above 100).
  const aboveHigh = nearestTargetDistance(210, 200, 100);
  assert.ok(aboveHigh);
  assert.equal(aboveHigh.side, "low");
  // Close <= low: low side suppressed, high side remains (50 below 200).
  const belowLow = nearestTargetDistance(50, 200, 100);
  assert.ok(belowLow);
  assert.equal(belowLow.side, "high");
  // Close exactly between but breached both (impossible normally) returns null.
  assert.equal(nearestTargetDistance(200, 200, 200), null);
});

test("computes distance to high when only high is meaningful", () => {
  const d = nearestTargetDistance(180, 200, null);
  assert.ok(d);
  assert.equal(d.side, "high");
  assert.equal(d.abs, 20);
  // Negative pct = close needs to rise.
  assert.ok(d.pct < 0);
  assert.ok(Math.abs(d.pct - (-20 / 180) * 100) < 1e-9);
});

test("computes distance to low when only low is meaningful", () => {
  const d = nearestTargetDistance(120, null, 100);
  assert.ok(d);
  assert.equal(d.side, "low");
  assert.equal(d.abs, 20);
  // Positive pct = close needs to fall.
  assert.ok(d.pct > 0);
  assert.ok(Math.abs(d.pct - (20 / 120) * 100) < 1e-9);
});

test("picks the closer side when both targets are unbreached", () => {
  // Close 190, high 200 (abs 10), low 100 (abs 90). High is closer.
  const d = nearestTargetDistance(190, 200, 100);
  assert.ok(d);
  assert.equal(d.side, "high");
  assert.equal(d.abs, 10);
});

test("picks low when close is nearer the low side", () => {
  // Close 105, high 200 (abs 95), low 100 (abs 5). Low is closer.
  const d = nearestTargetDistance(105, 200, 100);
  assert.ok(d);
  assert.equal(d.side, "low");
  assert.equal(d.abs, 5);
});

test("formatTargetDistancePct prints two digits under ten percent", () => {
  assert.equal(formatTargetDistancePct(0), "0.00%");
  assert.equal(formatTargetDistancePct(1.234), "+1.23%");
  assert.equal(formatTargetDistancePct(-2.5), "-2.50%");
  assert.equal(formatTargetDistancePct(15.4), "+15.4%");
});
