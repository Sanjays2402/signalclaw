// Tests for the privacy store: GDPR Article 17 / 20.
// Run with: node --experimental-strip-types --test tests/privacyStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-privacy-"));
process.chdir(tmpRoot);
const DATA = path.join(tmpRoot, ".data");
await fs.mkdir(DATA, { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const priv = await import(path.join(repoRoot, "lib", "privacyStore.ts"));

async function seed(name, contents) {
  await fs.writeFile(path.join(DATA, name), contents);
}

test("export bundle is well-formed even with no data files", async () => {
  const b = await priv.collectExport();
  assert.ok(b.exported_at);
  assert.equal(b.generator, "signalclaw-next/privacy-export");
  // every known store is represented, even if empty.
  for (const spec of priv.PRIVACY_STORES) {
    assert.ok(spec.name in b.stores, `missing ${spec.name}`);
    assert.equal(b.stores[spec.name].category, spec.category);
  }
});

test("export reads json and jsonl stores", async () => {
  await seed("runs.json", JSON.stringify({ runs: [{ id: "r1" }] }));
  await seed("audit.jsonl", '{"a":1}\n{"a":2}\n\n');
  const b = await priv.collectExport();
  assert.deepEqual(b.stores.runs.data, { runs: [{ id: "r1" }] });
  assert.deepEqual(b.stores.audit.data, [{ a: 1 }, { a: 2 }]);
});

test("describeErase keeps compliance + audit by default", () => {
  const plan = priv.describeErase({});
  assert.ok(plan.willRemove.includes("runs.json"));
  assert.ok(plan.willRemove.includes("watchlist.json"));
  assert.ok(plan.willPreserve.includes("audit.jsonl"));
  assert.ok(plan.willPreserve.includes("keys.json"));
  assert.ok(plan.willPreserve.includes("webhook-deliveries.json"));
});

test("describeErase honours wipeCompliance and wipeAudit", () => {
  const plan = priv.describeErase({ wipeCompliance: true, wipeAudit: true });
  assert.ok(plan.willRemove.includes("audit.jsonl"));
  assert.ok(plan.willRemove.includes("keys.json"));
  assert.equal(plan.willPreserve.length, 0);
});

test("eraseAll removes user data but preserves audit and keys by default", async () => {
  await seed("runs.json", '{"runs":[]}');
  await seed("watchlist.json", '{"items":[]}');
  await seed("audit.jsonl", '{"a":1}\n');
  await seed("keys.json", '{"keys":[]}');
  const summary = await priv.eraseAll({});
  assert.ok(summary.removed.includes("runs.json"));
  assert.ok(summary.removed.includes("watchlist.json"));
  assert.ok(summary.preserved.includes("audit.jsonl"));
  assert.ok(summary.preserved.includes("keys.json"));
  // audit and keys files must still be on disk.
  await fs.access(path.join(DATA, "audit.jsonl"));
  await fs.access(path.join(DATA, "keys.json"));
  // runs and watchlist are gone.
  await assert.rejects(fs.access(path.join(DATA, "runs.json")));
  await assert.rejects(fs.access(path.join(DATA, "watchlist.json")));
});

test("eraseAll with wipeAudit removes audit log", async () => {
  await seed("audit.jsonl", '{"a":1}\n');
  await seed("audit.jsonl.1", '{"a":0}\n');
  const summary = await priv.eraseAll({ wipeAudit: true });
  assert.ok(summary.removed.includes("audit.jsonl"));
  assert.ok(summary.removed.includes("audit.jsonl.1"));
  await assert.rejects(fs.access(path.join(DATA, "audit.jsonl")));
});

test("eraseAll is idempotent on missing files", async () => {
  // Already wiped from prior tests; should not throw.
  const summary = await priv.eraseAll({ wipeCompliance: true, wipeAudit: true });
  assert.ok(Array.isArray(summary.removed));
  assert.equal(typeof summary.bytes_freed, "number");
});

test("exportFilename has a stable shape", () => {
  const f = priv.exportFilename(new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(f, "signalclaw-export-2026-01-02T03-04-05-000Z.json");
});
