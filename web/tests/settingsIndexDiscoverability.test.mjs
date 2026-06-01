// node --experimental-strip-types --test tests/settingsIndexDiscoverability.test.mjs
//
// Procurement reviewers ask "where do I configure X?" and walk away if the
// answer is "open this file path". Every page under /settings/* must be
// reachable from the /settings index, otherwise the feature effectively
// does not exist for evaluators. This test pins that contract.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const settingsDir = path.join(repoRoot, "app", "settings");
const indexPath = path.join(settingsDir, "page.tsx");

async function listTopSubpages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pagePath = path.join(dir, e.name, "page.tsx");
    try {
      await fs.access(pagePath);
      out.push("/" + e.name);
    } catch {
      /* no leaf page.tsx at this level, ignore */
    }
  }
  return out;
}

test("every top-level /settings/<page> is linked from the /settings index", async () => {
  const indexSrc = await fs.readFile(indexPath, "utf8");
  const subpages = await listTopSubpages(settingsDir);
  assert.ok(subpages.length > 0, "expected at least one /settings/* subpage");

  const missing = [];
  for (const sub of subpages) {
    const href = "/settings" + sub;
    if (!indexSrc.includes(`href="${href}"`)) missing.push(href);
  }
  assert.equal(
    missing.length,
    0,
    `unlinked settings pages would be invisible to enterprise reviewers: ${missing.join(", ")}`,
  );
});

test("/settings index links the observability page", async () => {
  const indexSrc = await fs.readFile(indexPath, "utf8");
  assert.match(indexSrc, /href="\/settings\/observability"/);
});

test("observability page is reachable and renders a probe surface", async () => {
  const page = await fs.readFile(
    path.join(settingsDir, "observability", "page.tsx"),
    "utf8",
  );
  assert.match(page, /\/healthz/);
  assert.match(page, /\/readyz/);
  assert.match(page, /\/metrics/);
  assert.match(page, /X-Request-Id/);
});
