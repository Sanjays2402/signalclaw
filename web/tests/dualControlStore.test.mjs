// node --experimental-strip-types --test tests/dualControlStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-dualctl-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "lib", "dualControlStore.ts"));
const {
  requestApproval,
  approveRequest,
  consumeApproval,
  cancelRequest,
  listRequests,
  getRequest,
  __resetDualControlCache,
} = mod;

async function freshState() {
  __resetDualControlCache();
  try {
    await fs.unlink(path.join(tmpRoot, ".data", "dual_control.json"));
  } catch {}
}

test("happy path: maker requests, checker approves, maker consumes", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "key_abc",
    reason: "rotating compromised key",
    requested_by: "alice",
  });
  assert.equal(r.ok, true);
  assert.equal(r.request.status, "pending");

  const a = await approveRequest({ id: r.request.id, approver: "bob" });
  assert.equal(a.ok, true);
  assert.equal(a.request.status, "approved");
  assert.equal(a.request.approved_by, "bob");
  assert.ok(a.token && a.token.length > 20);

  const c = await consumeApproval({
    action: "keys.revoke",
    target: "key_abc",
    token: a.token,
    caller: "alice",
  });
  assert.equal(c.ok, true);
  assert.equal(c.request.status, "consumed");
});

test("self-approval is rejected (separation of duties)", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "key_xyz",
    reason: "test",
    requested_by: "alice",
  });
  assert.equal(r.ok, true);
  const a = await approveRequest({ id: r.request.id, approver: "alice" });
  assert.equal(a.ok, false);
  assert.equal(a.code, "self_approval");
});

test("token cannot be consumed by a different caller", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const a = await approveRequest({ id: r.request.id, approver: "bob" });
  assert.equal(a.ok, true);
  const c = await consumeApproval({
    action: "keys.revoke",
    target: "k1",
    token: a.token,
    caller: "mallory",
  });
  assert.equal(c.ok, false);
  assert.equal(c.code, "wrong_caller");
});

test("token cannot be re-bound to a different action or target", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const a = await approveRequest({ id: r.request.id, approver: "bob" });
  const wrongAction = await consumeApproval({
    action: "keys.suspend",
    target: "k1",
    token: a.token,
    caller: "alice",
  });
  assert.equal(wrongAction.ok, false);
  assert.equal(wrongAction.code, "action_mismatch");

  const wrongTarget = await consumeApproval({
    action: "keys.revoke",
    target: "k2",
    token: a.token,
    caller: "alice",
  });
  assert.equal(wrongTarget.ok, false);
  assert.equal(wrongTarget.code, "target_mismatch");
});

test("tokens are single-use", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const a = await approveRequest({ id: r.request.id, approver: "bob" });
  const first = await consumeApproval({
    action: "keys.revoke",
    target: "k1",
    token: a.token,
    caller: "alice",
  });
  assert.equal(first.ok, true);
  const replay = await consumeApproval({
    action: "keys.revoke",
    target: "k1",
    token: a.token,
    caller: "alice",
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "bad_token");
});

test("bad token is rejected", async () => {
  await freshState();
  const c = await consumeApproval({
    action: "keys.revoke",
    target: "k1",
    token: "not-a-real-token",
    caller: "alice",
  });
  assert.equal(c.ok, false);
  assert.equal(c.code, "bad_token");
});

test("cancelled request cannot be approved or consumed", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const cn = await cancelRequest({ id: r.request.id, actor: "alice" });
  assert.equal(cn.ok, true);
  const a = await approveRequest({ id: r.request.id, approver: "bob" });
  assert.equal(a.ok, false);
  assert.equal(a.code, "not_pending");
});

test("validation: action format, reason required, length bound", async () => {
  await freshState();
  const a1 = await requestApproval({
    action: "BAD ACTION",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  assert.equal(a1.ok, false);
  assert.equal(a1.code, "bad_action");

  const a2 = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "   ",
    requested_by: "alice",
  });
  assert.equal(a2.ok, false);
  assert.equal(a2.code, "bad_reason");

  const a3 = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x".repeat(1000),
    requested_by: "alice",
  });
  assert.equal(a3.ok, false);
  assert.equal(a3.code, "bad_reason");
});

test("duplicate pending request from same maker collapses, not duplicated", async () => {
  await freshState();
  const a = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const b = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.request.id, b.request.id);
  const list = await listRequests({ status: "pending" });
  assert.equal(list.filter((r) => r.target === "k1").length, 1);
});

test("listRequests returns rows newest first and supports status filter", async () => {
  await freshState();
  const r1 = await requestApproval({
    action: "keys.revoke",
    target: "a",
    reason: "x",
    requested_by: "alice",
  });
  await new Promise((res) => setTimeout(res, 5));
  const r2 = await requestApproval({
    action: "keys.suspend",
    target: "b",
    reason: "y",
    requested_by: "alice",
  });
  await cancelRequest({ id: r1.request.id, actor: "alice" });
  const all = await listRequests();
  assert.ok(all.length >= 2);
  // newest first: r2 (pending) comes before r1 (cancelled)
  assert.equal(all[0].id, r2.request.id);
  const pending = await listRequests({ status: "pending" });
  assert.ok(pending.every((r) => r.status === "pending"));
  const cancelled = await listRequests({ status: "cancelled" });
  assert.ok(cancelled.some((r) => r.id === r1.request.id));
});

test("getRequest returns a snapshot, never the stored row", async () => {
  await freshState();
  const r = await requestApproval({
    action: "keys.revoke",
    target: "k1",
    reason: "x",
    requested_by: "alice",
  });
  const g = await getRequest(r.request.id);
  assert.ok(g);
  g.status = "consumed"; // mutate snapshot
  const g2 = await getRequest(r.request.id);
  assert.equal(g2.status, "pending");
});
