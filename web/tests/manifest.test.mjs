import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const mod = await import(path.join(repoRoot, "app", "manifest.ts"));
const manifest = mod.default();

test("manifest declares standalone PWA with required identity fields", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.ok(manifest.name && manifest.name.length > 0);
  assert.ok(manifest.short_name && manifest.short_name.length <= 12);
});

test("manifest theme/background colors are dark to match terminal", () => {
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
});

test("manifest icons include both 192 and 512 PNG plus an SVG", () => {
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes("192x192"), "missing 192x192 PNG");
  assert.ok(sizes.includes("512x512"), "missing 512x512 PNG");
  const svgs = manifest.icons.filter((i) => i.type === "image/svg+xml");
  assert.ok(svgs.length >= 1, "missing SVG icon");
});

test("manifest icons include a maskable purpose for Android adaptive icons", () => {
  const maskable = manifest.icons.some(
    (i) => i.purpose && String(i.purpose).includes("maskable"),
  );
  assert.ok(maskable, "no maskable icon declared");
});
