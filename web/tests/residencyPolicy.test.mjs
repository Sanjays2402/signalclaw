// Workspace data residency policy.
// Run with: node --experimental-strip-types --test tests/residencyPolicy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "signalclaw-residency-"),
);
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const rs = await import(path.join(repoRoot, "lib", "residencyStore.ts"));

function makeReq(headers = {}) {
  return new Request("http://localhost/api/v1/runs", { headers });
}

test("default policy is off and global", async () => {
  const p = await rs.getResidencyPolicy();
  assert.equal(p.mode, "off");
  assert.equal(p.region, "global");
});

test("detectRequestRegion prefers explicit x-data-region", () => {
  const r = rs.detectRequestRegion(
    makeReq({ "x-data-region": "eu", "x-vercel-ip-country": "US" }),
  );
  assert.equal(r.region, "eu");
  assert.equal(r.source, "explicit");
});

test("detectRequestRegion falls back to country headers", () => {
  const r = rs.detectRequestRegion(makeReq({ "cf-ipcountry": "DE" }));
  assert.equal(r.region, "eu");
  assert.equal(r.source, "country");
  assert.equal(r.raw, "DE");
});

test("detectRequestRegion returns global+unknown when nothing matches", () => {
  const r = rs.detectRequestRegion(makeReq({ "cf-ipcountry": "ZZ" }));
  assert.equal(r.region, "global");
  assert.equal(r.source, "unknown");
});

test("decideResidency: off mode always allows", () => {
  const policy = { region: "eu", mode: "off", updated_at: "x", updated_by: null };
  const d = rs.decideResidency(makeReq({ "x-data-region": "us" }), policy, "POST");
  assert.equal(d.allowed, true);
  assert.equal(d.status, "ok");
});

test("decideResidency: enforce + matching region allows", () => {
  const policy = { region: "eu", mode: "enforce", updated_at: "x", updated_by: null };
  const d = rs.decideResidency(makeReq({ "x-data-region": "eu" }), policy, "POST");
  assert.equal(d.allowed, true);
  assert.equal(d.status, "ok");
});

test("decideResidency: enforce + mismatch on POST blocks (cross-region isolation)", () => {
  const policy = { region: "eu", mode: "enforce", updated_at: "x", updated_by: null };
  const d = rs.decideResidency(makeReq({ "x-data-region": "us" }), policy, "POST");
  assert.equal(d.allowed, false);
  assert.equal(d.status, "blocked");
  assert.match(d.reason, /residency_mismatch/);
});

test("decideResidency: enforce + mismatch on GET passes with warn (reads never blocked)", () => {
  const policy = { region: "eu", mode: "enforce", updated_at: "x", updated_by: null };
  const d = rs.decideResidency(makeReq({ "x-data-region": "us" }), policy, "GET");
  assert.equal(d.allowed, true);
  assert.equal(d.status, "warn");
});

test("decideResidency: monitor + mismatch passes with warn even on POST", () => {
  const policy = { region: "eu", mode: "monitor", updated_at: "x", updated_by: null };
  const d = rs.decideResidency(makeReq({ "x-data-region": "ap" }), policy, "POST");
  assert.equal(d.allowed, true);
  assert.equal(d.status, "warn");
});

test("setResidencyPolicy persists and validates", async () => {
  const saved = await rs.setResidencyPolicy({
    region: "eu",
    mode: "enforce",
    updated_by: "test",
  });
  assert.equal(saved.region, "eu");
  assert.equal(saved.mode, "enforce");
  const reread = await rs.getResidencyPolicy();
  assert.equal(reread.region, "eu");
  assert.equal(reread.mode, "enforce");
  await assert.rejects(
    () => rs.setResidencyPolicy({ region: "antarctica" }),
    /invalid_policy/,
  );
  await assert.rejects(
    () => rs.setResidencyPolicy({ mode: "panic" }),
    /invalid_policy/,
  );
});

test("isMutating identifies write methods only", () => {
  assert.equal(rs.isMutating("POST"), true);
  assert.equal(rs.isMutating("put"), true);
  assert.equal(rs.isMutating("DELETE"), true);
  assert.equal(rs.isMutating("GET"), false);
  assert.equal(rs.isMutating("HEAD"), false);
});
