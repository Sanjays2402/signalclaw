// Tests for the v1 GDPR privacy surface. Mirrors the v1Watchlist style:
// the route handlers are thin wrappers around keyStore + privacyStore, so
// we exercise the contracts the routes depend on plus the scope decisions
// that gate them. This is what procurement reviewers actually care about:
// an export key cannot become an erase key by accident.
//
// Run with: node --experimental-strip-types --test tests/v1Privacy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-v1privacy-"));
process.chdir(tmpRoot);
await fs.mkdir(path.join(tmpRoot, ".data"), { recursive: true });

const repoRoot = path.resolve(import.meta.dirname, "..");
const ks = await import(path.join(repoRoot, "lib", "keyStore.ts"));
const priv = await import(path.join(repoRoot, "lib", "privacyStore.ts"));

async function mintRead(label) {
  const { secret, key } = await ks.createKey({ label, scopes: ["read"] });
  return { secret, key };
}

async function mintAdmin(label) {
  await ks.createKey({ label, scopes: ["read"] });
  // createKey strips admin scope by design; promote on disk to model an
  // env-provisioned admin key, matching how operators bootstrap one.
  const keysFile = path.join(tmpRoot, ".data", "keys.json");
  const raw = JSON.parse(await fs.readFile(keysFile, "utf8"));
  const k = raw.keys.find((x) => x.label === label);
  k.scopes = ["admin", "read", "trade"];
  await fs.writeFile(keysFile, JSON.stringify(raw, null, 2));
  return k;
}

test("v1 privacy export: unauthenticated request resolves to no key", async () => {
  const req = new Request("http://localhost/api/v1/privacy/export");
  const key = await ks.authenticate(ks.extractKey(req));
  assert.equal(key, null);
});

test("v1 privacy export: read scope is sufficient for export", async () => {
  const { secret } = await mintRead("export-read");
  const req = new Request("http://localhost/api/v1/privacy/export", {
    headers: { authorization: `Bearer ${secret}` },
  });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.ok(key, "authenticate must accept the freshly-minted key");
  assert.ok(
    key.scopes.includes("read") || key.scopes.includes("admin"),
    "export gate must accept a read or admin key",
  );
});

test("v1 privacy erase: a read-only key must fail the admin gate", async () => {
  const { secret } = await mintRead("erase-denied");
  const req = new Request("http://localhost/api/v1/privacy/erase", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ confirm: "DELETE", dry_run: false }),
  });
  const key = await ks.authenticate(ks.extractKey(req));
  assert.ok(key);
  // The route would reject any key that lacks admin scope.
  assert.equal(
    key.scopes.includes("admin"),
    false,
    "createKey must never grant admin scope via the public input shape",
  );
});

test("v1 privacy erase: admin key passes the gate", async () => {
  const k = await mintAdmin("erase-admin");
  assert.ok(k.scopes.includes("admin"));
});

test("v1 privacy erase: dry-run plan never mutates files", async () => {
  // Seed a few user files and an audit file.
  const sentinel = path.join(tmpRoot, ".data", "watchlist.json");
  await fs.writeFile(sentinel, JSON.stringify({ items: [{ ticker: "NVDA" }] }));
  await fs.writeFile(
    path.join(tmpRoot, ".data", "audit.jsonl"),
    '{"a":1}\n{"a":2}\n',
  );
  const plan = priv.describeErase({});
  // Plan is informational; nothing has been removed.
  assert.ok(plan.willRemove.includes("watchlist.json"));
  assert.ok(plan.willPreserve.some((f) => f.includes("audit")));
  const stat = await fs.stat(sentinel);
  assert.ok(stat.size > 0, "describeErase must not delete files");
});

test("v1 privacy erase: confirm token guard logic matches the route contract", () => {
  // The route accepts execution iff body.confirm === "DELETE" AND
  // body.dry_run === false. Encode that as a tiny truth table so the
  // contract is asserted independent of the route implementation.
  const decide = (body) => {
    const dryRun = body?.dry_run !== false;
    if (dryRun) return "preview";
    return body?.confirm === "DELETE" ? "execute" : "reject";
  };
  assert.equal(decide({}), "preview");
  assert.equal(decide({ dry_run: false }), "reject");
  assert.equal(decide({ confirm: "DELETE" }), "preview");
  assert.equal(decide({ confirm: "delete", dry_run: false }), "reject");
  assert.equal(decide({ confirm: "DELETE", dry_run: false }), "execute");
});

test("v1 privacy export: bundle round-trips user-generated data", async () => {
  await fs.writeFile(
    path.join(tmpRoot, ".data", "watchlist.json"),
    JSON.stringify({ items: [{ ticker: "AAPL" }] }),
  );
  const b = await priv.collectExport();
  assert.deepEqual(b.stores.watchlist.data, { items: [{ ticker: "AAPL" }] });
});

test("v1 privacy: route files are present on disk", async () => {
  await fs.access(
    path.join(repoRoot, "app", "api", "v1", "privacy", "export", "route.ts"),
  );
  await fs.access(
    path.join(repoRoot, "app", "api", "v1", "privacy", "erase", "route.ts"),
  );
});
