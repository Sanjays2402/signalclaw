// node --experimental-strip-types --test tests/evidencePack.test.mjs
//
// Proves the SOC2 evidence pack is a real, well-formed .zip with the
// files the README promises, that its embedded manifest hashes match
// the archive contents, and that two packs built from identical inputs
// have identical SHA-256s for every member file (so an auditor can
// verify the bundle they were sent matches the bundle a re-run would
// produce, modulo the manifest's generated_at field).
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-evpack-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const ep = await import(path.join(repoRoot, "lib", "evidencePack.ts"));
const zb = await import(path.join(repoRoot, "lib", "zipBuilder.ts"));

// --- ZIP reader (central directory only, no compression) ---
// Just enough to enumerate names + extract stored entries so the test
// stays dep-free and proves the bundle is openable by any ZIP tool.
function readZip(buf) {
  const eocdOffset = (() => {
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new Error("no EOCD");
  })();
  const total = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "bad central sig");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    // Read local header to find data start.
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, "bad local sig");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + size);
    entries.push({ name, method, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(p - cdOffset, cdSize, "central dir size mismatch");
  return entries;
}

test("buildZip produces a parseable archive with stored entries", () => {
  const zip = zb.buildZip([
    { name: "hello.txt", data: "hello" },
    { name: "nested/sub.json", data: '{"ok":true}' },
  ]);
  const entries = readZip(zip);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, "hello.txt");
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].data.toString("utf8"), "hello");
  assert.equal(entries[1].name, "nested/sub.json");
  assert.equal(entries[1].data.toString("utf8"), '{"ok":true}');
});

test("evidence pack contains the documented files and a self-consistent manifest", async () => {
  const pack = await ep.buildEvidencePack("test-actor");
  assert.match(pack.filename, /^signalclaw-evidence-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.ok(pack.buffer.length > 0);

  const entries = readZip(pack.buffer);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const required = [
    "README.md",
    "manifest.json",
    "controls-inventory.json",
    "audit-chain-verification.json",
    "keys.json",
    "sessions.json",
    "policies/sso.json",
    "policies/network.json",
    "policies/cors.json",
    "policies/csp.json",
    "policies/retention.json",
    "policies/rotation.json",
    "policies/webhook-egress.json",
    "policies/residency.json",
    "policies/auth-lockout.json",
    "policies/concurrency.json",
    "policies/workspace-defaults.json",
    "policies/legal-holds.json",
    "policies/siem-sink.json",
    "policies/freeze.json",
  ];
  for (const name of required) {
    assert.ok(byName.has(name), `missing ${name}`);
  }

  // manifest.json must list every other file with a matching SHA-256.
  const manifestEntry = byName.get("manifest.json");
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  assert.equal(manifest.product, "signalclaw");
  assert.equal(manifest.generated_by, "test-actor");
  assert.equal(manifest.pack_version, "1");
  assert.ok(Array.isArray(manifest.files));
  const manifestNames = new Set(manifest.files.map((f) => f.name));
  for (const name of required) {
    if (name === "manifest.json") continue;
    assert.ok(manifestNames.has(name), `manifest missing ${name}`);
  }
  for (const f of manifest.files) {
    const ent = byName.get(f.name);
    assert.ok(ent, `manifest references missing entry ${f.name}`);
    const actual = crypto.createHash("sha256").update(ent.data).digest("hex");
    assert.equal(actual, f.sha256, `sha256 mismatch for ${f.name}`);
    assert.equal(ent.data.length, f.size, `size mismatch for ${f.name}`);
  }
});

test("evidence pack content files are deterministic across runs", async () => {
  const a = await ep.buildEvidencePack("actor-x");
  // Small delay so generated_at differs; everything else must still
  // hash the same.
  await new Promise((r) => setTimeout(r, 5));
  const b = await ep.buildEvidencePack("actor-x");
  const entsA = new Map(readZip(a.buffer).map((e) => [e.name, e.data]));
  const entsB = new Map(readZip(b.buffer).map((e) => [e.name, e.data]));
  for (const [name, dataA] of entsA) {
    if (name === "manifest.json") continue; // contains generated_at
    if (name === "controls-inventory.json") continue; // adminIndex stamps generated_at
    const dataB = entsB.get(name);
    assert.ok(dataB, `missing ${name} in second build`);
    assert.equal(
      crypto.createHash("sha256").update(dataA).digest("hex"),
      crypto.createHash("sha256").update(dataB).digest("hex"),
      `non-deterministic content for ${name}`,
    );
  }
});

test("evidence pack appears in the admin control inventory", async () => {
  const ai = await import(path.join(repoRoot, "lib", "adminIndex.ts"));
  const env = { ...process.env };
  delete env.SIGNALCLAW_ADMIN_KEY;
  const out = await ai.buildAdminIndex(env);
  const row = out.controls.find((c) => c.key === "evidence-pack");
  assert.ok(row, "evidence-pack row missing from control inventory");
  assert.equal(row.href, "/settings/evidence-pack");
  assert.equal(row.status, "enforcing");
});
