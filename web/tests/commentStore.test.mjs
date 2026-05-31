// Run with: node --experimental-strip-types --test tests/commentStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-comments-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "commentStore.ts"));

test("normalizeAuthor falls back to anon for junk input", () => {
  assert.equal(store.normalizeAuthor(""), "anon");
  assert.equal(store.normalizeAuthor(null), "anon");
  assert.equal(store.normalizeAuthor("   "), "anon");
  assert.equal(store.normalizeAuthor("alice"), "alice");
  assert.equal(store.normalizeAuthor("a".repeat(500)).length, store.MAX_AUTHOR_LEN);
});

test("normalizeBody strips control chars and trims", () => {
  assert.equal(store.normalizeBody("  hi\u0000there  "), "hithere");
  assert.equal(store.normalizeBody("hello"), "hello");
});

test("addComment persists and listComments returns sorted", async () => {
  const r1 = await store.addComment({
    run_id: "run-1",
    author: "alice",
    body: "first thought",
    ip: "1.2.3.4",
  });
  assert.equal(r1.ok, true);
  // tiny delay to ensure created_at ordering is deterministic
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await store.addComment({
    run_id: "run-1",
    author: "bob",
    body: "second thought",
    ip: "9.9.9.9",
  });
  assert.equal(r2.ok, true);

  const items = await store.listComments("run-1");
  assert.equal(items.length, 2);
  assert.equal(items[0].author, "alice");
  assert.equal(items[1].author, "bob");
  assert.ok(items[0].id !== items[1].id);
  // ip_hash exists internally but publicView strips it
  const pub = store.publicView(items[0]);
  assert.equal(pub.ip_hash, undefined);
});

test("rate limit blocks the 4th post from the same IP within a minute", async () => {
  const ip = "5.5.5.5";
  for (let i = 0; i < 3; i++) {
    const r = await store.addComment({
      run_id: "run-rate",
      author: "spammer",
      body: `msg ${i}`,
      ip,
    });
    assert.equal(r.ok, true, `post ${i} should succeed`);
  }
  const blocked = await store.addComment({
    run_id: "run-rate",
    author: "spammer",
    body: "one more",
    ip,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "rate_limited");

  // A different IP is unaffected
  const fresh = await store.addComment({
    run_id: "run-rate",
    author: "other",
    body: "hi",
    ip: "6.6.6.6",
  });
  assert.equal(fresh.ok, true);
});

test("empty body is rejected", async () => {
  const r = await store.addComment({
    run_id: "run-x",
    author: "alice",
    body: "   ",
    ip: "1.1.1.1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty_body");
});

test("deleteComment removes only the targeted comment", async () => {
  const a = await store.addComment({
    run_id: "run-del",
    author: "a",
    body: "keep me",
    ip: "2.2.2.2",
  });
  const b = await store.addComment({
    run_id: "run-del",
    author: "b",
    body: "delete me",
    ip: "3.3.3.3",
  });
  assert.ok(a.ok && b.ok);
  const ok = await store.deleteComment("run-del", b.comment.id);
  assert.equal(ok, true);
  const items = await store.listComments("run-del");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, a.comment.id);

  const miss = await store.deleteComment("run-del", "nope");
  assert.equal(miss, false);
});
