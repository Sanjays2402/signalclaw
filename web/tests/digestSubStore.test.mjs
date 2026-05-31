// Test the digest subscription store: validation, CRUD, signature, due logic,
// payload rendering. Uses an isolated temp .data directory.
// Run: node --experimental-strip-types --test tests/digestSubStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-digestsubs-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "digestSubStore.ts"));

test("validateSubInput rejects bad urls and bad cadence", () => {
  assert.equal(mod.validateSubInput({ url: "" }).ok, false);
  assert.equal(mod.validateSubInput({ url: "ftp://nope" }).ok, false);
  assert.equal(mod.validateSubInput({ url: "https://x", cadence: "hourly" }).ok, false);
  assert.equal(mod.validateSubInput({ url: "https://x" }).ok, true);
  assert.equal(mod.validateSubInput({ url: "https://x", days: 0 }).ok, false);
  assert.equal(mod.validateSubInput({ url: "https://x", days: 999 }).ok, false);
  assert.equal(mod.validateSubInput({ url: "https://x", days: 14 }).ok, true);
});

test("createSub persists, getSub reads, listSubs orders by created_at desc", async () => {
  const a = await mod.createSub({ url: "https://a.example", label: "A", cadence: "daily" });
  assert.equal(a.ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const b = await mod.createSub({ url: "https://b.example", label: "B", cadence: "weekly" });
  assert.equal(b.ok, true);
  const list = await mod.listSubs();
  assert.ok(list.length >= 2);
  assert.equal(list[0].label, "B");
  const got = await mod.getSub(a.subscription.id);
  assert.ok(got);
  assert.equal(got.url, "https://a.example");
  assert.equal(got.days, 1);
  assert.ok(got.secret.startsWith("ds_"));
});

test("updateSub merges valid fields, ignores invalid", async () => {
  const c = await mod.createSub({ url: "https://c.example", cadence: "weekly", days: 7 });
  assert.equal(c.ok, true);
  const upd = await mod.updateSub(c.subscription.id, {
    label: "renamed",
    days: 14,
    enabled: false,
    cadence: "hourly",
    url: "not a url",
  });
  assert.ok(upd);
  assert.equal(upd.label, "renamed");
  assert.equal(upd.days, 14);
  assert.equal(upd.enabled, false);
  assert.equal(upd.cadence, "weekly");
  assert.equal(upd.url, "https://c.example");
});

test("deleteSub removes the row", async () => {
  const d = await mod.createSub({ url: "https://d.example" });
  assert.equal(d.ok, true);
  const ok = await mod.deleteSub(d.subscription.id);
  assert.equal(ok, true);
  assert.equal(await mod.deleteSub(d.subscription.id), false);
  assert.equal(await mod.getSub(d.subscription.id), null);
});

test("signBody is HMAC-SHA256 and deterministic", () => {
  const sig1 = mod.signBody("secret", "hello");
  const sig2 = mod.signBody("secret", "hello");
  const sig3 = mod.signBody("secret", "hello2");
  assert.equal(sig1, sig2);
  assert.notEqual(sig1, sig3);
  assert.match(sig1, /^sha256=[a-f0-9]{64}$/);
});

test("isDueNow respects cadence and last delivery", () => {
  const baseSub = {
    id: "x",
    label: "x",
    url: "https://x",
    cadence: "daily",
    days: 1,
    format: "json",
    secret: "s",
    enabled: true,
    owner: "local",
    created_at: new Date().toISOString(),
    last_delivered_at: null,
    last_status: null,
    last_error: null,
  };
  assert.equal(mod.isDueNow(baseSub), true);
  assert.equal(mod.isDueNow({ ...baseSub, enabled: false }), false);
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(mod.isDueNow({ ...baseSub, last_delivered_at: recent }), false);
  const yday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  assert.equal(mod.isDueNow({ ...baseSub, last_delivered_at: yday }), true);
  assert.equal(
    mod.isDueNow({ ...baseSub, cadence: "weekly", last_delivered_at: yday }),
    false,
  );
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(
    mod.isDueNow({ ...baseSub, cadence: "weekly", last_delivered_at: old }),
    true,
  );
});

test("buildPayload renders slack / json / text shapes", () => {
  const sub = {
    id: "s1",
    label: "L",
    url: "https://x",
    cadence: "daily",
    days: 1,
    format: "slack",
    secret: "s",
    enabled: true,
    owner: "local",
    created_at: new Date().toISOString(),
    last_delivered_at: null,
    last_status: null,
    last_error: null,
  };
  const digest = {
    headline: "All quiet",
    text: "plain text body",
    html: "<p>body</p>",
    stats: { runs: 0 },
    range: { days: 1, since: "a", until: "b" },
  };
  const slack = JSON.parse(mod.buildPayload(sub, digest));
  assert.equal(slack.text, "All quiet");
  assert.ok(Array.isArray(slack.blocks));
  const json = JSON.parse(mod.buildPayload({ ...sub, format: "json" }, digest));
  assert.equal(json.subscription_id, "s1");
  assert.equal(json.cadence, "daily");
  const text = mod.buildPayload({ ...sub, format: "text" }, digest);
  assert.equal(text, "plain text body");
});
