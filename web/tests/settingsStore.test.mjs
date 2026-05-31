// Plain Node test for the settings store. Run with:
//   node --experimental-strip-types --test tests/settingsStore.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "signalclaw-settings-"));
process.chdir(tmpRoot);

const repoRoot = path.resolve(import.meta.dirname, "..");
const store = await import(path.join(repoRoot, "lib", "settingsStore.ts"));

test("getSettings returns defaults when no file present", async () => {
  const s = await store.getSettings();
  assert.equal(s.profile.display_name, "");
  assert.equal(s.profile.base_currency, "USD");
  assert.equal(s.notifications.email_digest, false);
  assert.equal(s.notifications.digest_frequency, "daily");
  assert.ok(Array.isArray(s.notifications.alert_kinds));
});

test("updateProfile validates email and persists", async () => {
  await assert.rejects(
    () => store.updateProfile({ email: "not-an-email" }),
    /invalid email/,
  );
  const s = await store.updateProfile({
    display_name: "Sanjay",
    email: "s@example.com",
    base_currency: "eur",
  });
  assert.equal(s.profile.display_name, "Sanjay");
  assert.equal(s.profile.email, "s@example.com");
  assert.equal(s.profile.base_currency, "EUR");

  const reread = await store.getSettings();
  assert.equal(reread.profile.email, "s@example.com");
  assert.equal(reread.profile.base_currency, "EUR");
});

test("updateNotifications clamps quiet hours and filters kinds", async () => {
  const s = await store.updateNotifications({
    email_digest: true,
    digest_frequency: "weekly",
    alert_kinds: ["entered", "bogus", "score_jump", "entered"],
    quiet_hours_start: 99,
    quiet_hours_end: 7,
  });
  assert.equal(s.notifications.email_digest, true);
  assert.equal(s.notifications.digest_frequency, "weekly");
  assert.deepEqual(s.notifications.alert_kinds.sort(), ["entered", "score_jump"]);
  // 99 is invalid -> falls back to current value (default 22)
  assert.equal(s.notifications.quiet_hours_start, 22);
  assert.equal(s.notifications.quiet_hours_end, 7);

  await assert.rejects(
    () => store.updateNotifications({ digest_frequency: "hourly" }),
    /invalid digest_frequency/,
  );
});

test("exportAccount + deleteAccount round-trip", async () => {
  // Seed a fake sibling data file to confirm export+delete covers it.
  const dataDir = path.join(tmpRoot, ".data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "journal.json"),
    JSON.stringify({ entries: [{ id: "j1", note: "hi" }] }),
  );

  const bundle = await store.exportAccount();
  assert.equal(bundle.schema, "signalclaw.account.v1");
  assert.ok(bundle["settings.json"], "settings.json should be in bundle");
  assert.ok(bundle["journal.json"], "seeded journal should be in bundle");

  const { deleted } = await store.deleteAccount();
  assert.ok(deleted.includes("settings.json"));
  assert.ok(deleted.includes("journal.json"));

  // After delete, getSettings returns defaults again.
  const after = await store.getSettings();
  assert.equal(after.profile.email, "");
});
