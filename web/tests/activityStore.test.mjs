// Plain Node test for the activity store.
// Run with: node --experimental-strip-types --test tests/activityStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-activity-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "activityStore.ts"));

test("records and queries activity events", async () => {
  const ev = await store.recordActivity({
    kind: "run.saved",
    title: "Saved run · SPY",
    body: "bull regime",
    href: "/r/abc",
  });
  assert.ok(ev.id);
  assert.equal(ev.read, false);
  assert.equal(ev.kind, "run.saved");
  assert.equal(ev.href, "/r/abc");

  const out = await store.queryActivity({ limit: 10 });
  assert.equal(out.total, 1);
  assert.equal(out.unread, 1);
  assert.equal(out.events[0].title, "Saved run · SPY");
});

test("rejects invalid kinds and missing titles", async () => {
  await assert.rejects(() =>
    store.recordActivity({ kind: "nope", title: "x" }),
  );
  await assert.rejects(() =>
    store.recordActivity({ kind: "system", title: "  " }),
  );
});

test("rejects non-relative hrefs", async () => {
  const ev = await store.recordActivity({
    kind: "system",
    title: "external link guarded",
    href: "https://evil.example.com/x",
  });
  assert.equal(ev.href, null);
});

test("filters by kind and unreadOnly", async () => {
  await store.recordActivity({ kind: "webhook.delivered", title: "wh ok" });
  await store.recordActivity({ kind: "batch.completed", title: "batch done" });
  const onlyBatch = await store.queryActivity({ kind: "batch.completed" });
  assert.equal(onlyBatch.events.length, 1);
  assert.equal(onlyBatch.events[0].kind, "batch.completed");

  const unread = await store.queryActivity({ unreadOnly: true });
  assert.ok(unread.events.every((e) => !e.read));
});

test("mark read and mark all read", async () => {
  const before = await store.queryActivity({ limit: 100 });
  const first = before.events[0];
  const ev = await store.markRead(first.id);
  assert.equal(ev.read, true);
  const updated = await store.markAllRead();
  assert.ok(updated >= 0);
  const after = await store.queryActivity({ limit: 100 });
  assert.equal(after.unread, 0);
});

test("delete event and clear all", async () => {
  await store.recordActivity({ kind: "system", title: "to delete" });
  const list = await store.queryActivity({ limit: 100 });
  const target = list.events.find((e) => e.title === "to delete");
  assert.ok(target);
  const ok = await store.deleteEvent(target.id);
  assert.equal(ok, true);
  const missing = await store.deleteEvent("doesnotexist");
  assert.equal(missing, false);
  const cleared = await store.clearAll();
  assert.ok(cleared >= 0);
  const final = await store.queryActivity({ limit: 100 });
  assert.equal(final.total, 0);
});

test("recordSafe never throws", async () => {
  await store.recordSafe({ kind: "definitely_bad", title: "x" });
  await store.recordSafe({ kind: "system", title: "ok" });
  const out = await store.queryActivity({ limit: 10 });
  assert.ok(out.total >= 1);
});
