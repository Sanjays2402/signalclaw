import { test } from "node:test";
import assert from "node:assert/strict";

const { buildRunPdf, pdfFilename } = await import("../lib/runPdf.ts");

function makeRun(overrides = {}) {
  return {
    id: "abcdef12345",
    label: "AAPL bull run",
    ticker: "AAPL",
    lookback_days: 180,
    created_at: "2025-01-15T12:34:56.000Z",
    tags: ["earnings", "tech"],
    notes: "Strong momentum after earnings beat.",
    payload: {
      ticker: "AAPL",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04"],
      close: [100, 101.5, 99.8, 103.2],
      regime: ["bull", "bull", "chop", "bull"],
      counts: { bull: 3, chop: 1 },
      snapshot: {
        label: "bull",
        realized_vol: 0.1234,
        trend_slope: 0.001,
        drawdown: -0.0567,
        confidence: 0.876,
        risk_scale: 1,
        as_of: "2025-01-04",
      },
      disclaimer: "not advice",
    },
    ...overrides,
  };
}

test("buildRunPdf returns a valid PDF byte stream", () => {
  const bytes = buildRunPdf(makeRun());
  assert.ok(bytes instanceof Uint8Array, "returns Uint8Array");
  assert.ok(bytes.length > 800, `pdf has body, got ${bytes.length} bytes`);
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  assert.ok(head.startsWith("%PDF-1.4"), `starts with PDF header, got ${head}`);
  const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 16));
  assert.ok(tail.includes("%%EOF"), `ends with EOF marker, got ${tail}`);
});

test("buildRunPdf survives missing snapshot and empty counts", () => {
  const run = makeRun();
  run.payload.snapshot = null;
  run.payload.counts = {};
  const bytes = buildRunPdf(run);
  assert.ok(bytes.length > 400);
  const head = new TextDecoder().decode(bytes.subarray(0, 8));
  assert.ok(head.startsWith("%PDF-1.4"));
});

test("buildRunPdf escapes parens and non-ascii safely", () => {
  const run = makeRun({
    label: "weird (label) with \\ and emoji \u2728",
    notes: "note (with parens) and \u00e9 char",
  });
  const bytes = buildRunPdf(run);
  const txt = new TextDecoder("latin1").decode(bytes);
  // Raw "(label)" must not appear unescaped inside our text op.
  assert.ok(!/\(weird \(label\) with/.test(txt), "parens should be escaped");
  assert.ok(/%PDF-1.4/.test(txt));
});

test("pdfFilename produces a safe, descriptive name", () => {
  const name = pdfFilename(makeRun());
  assert.match(name, /^signalclaw_AAPL_2025-01-15_abcdef12\.pdf$/);
});

test("pdfFilename sanitizes the ticker", () => {
  const name = pdfFilename(makeRun({ ticker: "BRK.B / weird" }));
  assert.ok(name.endsWith(".pdf"));
  assert.ok(!name.includes("/"));
  assert.ok(!name.includes(" "));
});
