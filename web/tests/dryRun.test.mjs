// node --experimental-strip-types --test tests/dryRun.test.mjs
//
// Sandbox / dry-run helper for /api/v1 mutating endpoints. Confirms the
// detection logic (query string, header, JSON body) and the shape of the
// preview response, and proves that runCheck({ dryRun: true }) does not
// persist alert state. Cross-tenant style isolation here means: a dry-run
// call must not change any persisted store.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-dryrun-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const dry = await import(path.join(repoRoot, "lib", "dryRunCore.ts"));
const alerts = await import(path.join(repoRoot, "lib", "alertStore.ts"));

function makeReq(url, headers = {}) {
  return new Request(url, { headers });
}

test("dryRun: ?dry_run=true detected", () => {
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs?dry_run=true")), true);
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs?dry_run=1")), true);
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs?dry_run=yes")), true);
});

test("dryRun: ?dry_run=false overrides any body opt-in", () => {
  // Query is checked first; an explicit false short-circuits before body.
  assert.equal(
    dry.isDryRun(makeReq("http://x/api/v1/runs?dry_run=false"), { dry_run: true }),
    false,
  );
});

test("dryRun: X-Dry-Run header detected", () => {
  assert.equal(
    dry.isDryRun(makeReq("http://x/api/v1/runs", { "x-dry-run": "true" })),
    true,
  );
  assert.equal(
    dry.isDryRun(makeReq("http://x/api/v1/runs", { "x-dry-run": "1" })),
    true,
  );
  assert.equal(
    dry.isDryRun(makeReq("http://x/api/v1/runs", { "x-dry-run": "no" })),
    false,
  );
});

test("dryRun: body dry_run: true detected", () => {
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs"), { dry_run: true }), true);
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs"), { dry_run: false }), false);
  assert.equal(dry.isDryRun(makeReq("http://x/api/v1/runs"), {}), false);
});

test("alertStore.runCheck with dryRun does not persist last_fired_at", async () => {
  // Arm one alert and force-fire it via a supplied price.
  const r = await alerts.createAlert({
    ticker: "TEST",
    condition: "price_above",
    value: 100,
    cooldown_hours: 0,
    enabled: true,
  });
  assert.equal(r.ok, true);
  const armedId = r.ok ? r.alert.id : "";

  const before = await alerts.listAlerts();
  const beforeFired = before.find((a) => a.id === armedId)?.last_fired_at;

  const result = await alerts.runCheck({ TEST: 999 }, { dryRun: true });
  assert.ok(result.hits.length >= 1, "alert should match in evaluation");

  const after = await alerts.listAlerts();
  const afterFired = after.find((a) => a.id === armedId)?.last_fired_at;
  assert.equal(afterFired, beforeFired, "dryRun must not persist last_fired_at");

  // And a real call DOES persist.
  const real = await alerts.runCheck({ TEST: 999 });
  assert.ok(real.hits.length >= 1);
  const after2 = await alerts.listAlerts();
  const after2Fired = after2.find((a) => a.id === armedId)?.last_fired_at;
  assert.ok(after2Fired, "real call must persist last_fired_at");
});
