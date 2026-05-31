// Minimal, zero-dependency PDF generator for a single saved run.
// Produces a one-page Letter-size PDF report with the run summary,
// regime distribution, and a sparkline of the closing price.
//
// Pure function so it can be unit-tested without booting Next.
import type { SavedRun } from "./runStore.ts";

// Small inline helpers (kept here so the file has no runtime imports
// from other lib modules, which lets the Node test runner load it
// with `--experimental-strip-types` and lets the Next build use the
// normal bundler resolver without a `.ts` extension on a value import).
function ogFields(run: SavedRun, id: string) {
  const snap = run.payload.snapshot;
  return {
    id,
    ticker: run.ticker ?? "UNKNOWN",
    label: (snap?.label ?? "no-snapshot").toUpperCase(),
    conf: snap ? `${Math.round(snap.confidence * 100)}%` : "--",
    vol: snap ? `${(snap.realized_vol * 100).toFixed(1)}%` : "--",
    dd: snap ? `${(snap.drawdown * 100).toFixed(1)}%` : "--",
    bars: run.payload.dates.length,
  };
}

// PDF color in 0..1 RGB triples.
const COLORS: Record<string, [number, number, number]> = {
  bull: [0.20, 0.83, 0.60],
  chop: [0.98, 0.75, 0.14],
  bear: [0.97, 0.44, 0.44],
  crash: [0.94, 0.27, 0.27],
};

function color(label: string | undefined | null): [number, number, number] {
  if (!label) return [0.64, 0.64, 0.64];
  return COLORS[label] ?? [0.64, 0.64, 0.64];
}

// Escape a string for a PDF literal `( ... )`.
function pdfStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Strip characters outside basic Latin so we stay safe with WinAnsi.
function ascii(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, "?");
}

type Op = string;

function fmtNum(n: number): string {
  // Avoid scientific notation, cap to 3 decimals.
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function moveTo(x: number, y: number): Op { return `${fmtNum(x)} ${fmtNum(y)} m`; }
function lineTo(x: number, y: number): Op { return `${fmtNum(x)} ${fmtNum(y)} l`; }
function rect(x: number, y: number, w: number, h: number): Op { return `${fmtNum(x)} ${fmtNum(y)} ${fmtNum(w)} ${fmtNum(h)} re`; }
function setFill(rgb: [number, number, number]): Op { return `${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} rg`; }
function setStroke(rgb: [number, number, number]): Op { return `${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} RG`; }

type TextOp = { font: "F1" | "F2"; size: number; x: number; y: number; text: string };

function text(op: TextOp): Op {
  return `BT /${op.font} ${fmtNum(op.size)} Tf ${fmtNum(op.x)} ${fmtNum(op.y)} Td (${pdfStr(ascii(op.text))}) Tj ET`;
}

export function buildRunPdf(run: SavedRun): Uint8Array {
  // Letter: 612 x 792 pt.
  const W = 612;
  const H = 792;
  const M = 48; // margin

  const f = ogFields(run, run.id);
  const snap = run.payload.snapshot;
  const close = run.payload.close;
  const counts = run.payload.counts ?? {};
  const created = new Date(run.created_at).toISOString().slice(0, 19).replace("T", " ");

  const ops: Op[] = [];

  // Page background already white; draw header band.
  ops.push(setFill([0.07, 0.09, 0.13])); // near-slate-900
  ops.push(rect(0, H - 96, W, 96), "f");

  // Header title and label badge.
  ops.push(setFill([1, 1, 1]));
  ops.push(text({ font: "F2", size: 22, x: M, y: H - 50, text: `${f.ticker}  ${f.label}` }));
  ops.push(setFill([0.7, 0.74, 0.82]));
  ops.push(text({ font: "F1", size: 11, x: M, y: H - 72, text: `SignalClaw regime report - ${f.bars} bars - ${run.lookback_days}d lookback` }));

  // Confidence pill on the right.
  const pillX = W - M - 110;
  ops.push(setFill(color(snap?.label)));
  ops.push(rect(pillX, H - 70, 110, 28), "f");
  ops.push(setFill([1, 1, 1]));
  ops.push(text({ font: "F2", size: 14, x: pillX + 14, y: H - 53, text: `Conf ${f.conf}` }));

  // Run meta block.
  let y = H - 140;
  ops.push(setFill([0.13, 0.16, 0.22]));
  ops.push(text({ font: "F2", size: 13, x: M, y, text: ascii(run.label || `Run ${run.id}`) }));
  y -= 16;
  ops.push(setFill([0.42, 0.46, 0.54]));
  ops.push(text({ font: "F1", size: 10, x: M, y, text: `id ${run.id}   created ${created} UTC` }));

  // Stat grid (4 stats).
  const stats: Array<[string, string]> = [
    ["Realized vol", f.vol],
    ["Drawdown", f.dd],
    ["Trend slope", snap ? fmtNum(snap.trend_slope) : "--"],
    ["Risk scale", snap ? fmtNum(snap.risk_scale) : "--"],
  ];
  const statW = (W - 2 * M) / stats.length;
  const statY = y - 56;
  stats.forEach(([label, value], i) => {
    const x = M + i * statW;
    ops.push(setStroke([0.86, 0.88, 0.92]));
    ops.push(rect(x + 4, statY, statW - 8, 48), "S");
    ops.push(setFill([0.42, 0.46, 0.54]));
    ops.push(text({ font: "F1", size: 9, x: x + 12, y: statY + 32, text: label }));
    ops.push(setFill([0.13, 0.16, 0.22]));
    ops.push(text({ font: "F2", size: 14, x: x + 12, y: statY + 12, text: value }));
  });

  // Sparkline of closing price.
  const chartTop = statY - 24;
  const chartH = 200;
  const chartY = chartTop - chartH;
  const chartX = M;
  const chartW = W - 2 * M;
  ops.push(setFill([0.13, 0.16, 0.22]));
  ops.push(text({ font: "F2", size: 12, x: chartX, y: chartTop - 14, text: "Close price" }));
  ops.push(setStroke([0.86, 0.88, 0.92]));
  ops.push(rect(chartX, chartY, chartW, chartH), "S");

  if (close.length >= 2) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of close) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = hi - lo || 1;
    const pad = 10;
    const innerW = chartW - 2 * pad;
    const innerH = chartH - 2 * pad;
    ops.push(setStroke(color(snap?.label)));
    ops.push("1.4 w");
    for (let i = 0; i < close.length; i++) {
      const v = close[i];
      if (!Number.isFinite(v)) continue;
      const px = chartX + pad + (i / (close.length - 1)) * innerW;
      const py = chartY + pad + ((v - lo) / span) * innerH;
      ops.push(i === 0 ? moveTo(px, py) : lineTo(px, py));
    }
    ops.push("S");
    // Axis labels.
    ops.push(setFill([0.42, 0.46, 0.54]));
    ops.push(text({ font: "F1", size: 8, x: chartX + 4, y: chartY + chartH - 10, text: fmtNum(hi) }));
    ops.push(text({ font: "F1", size: 8, x: chartX + 4, y: chartY + 4, text: fmtNum(lo) }));
    ops.push(text({ font: "F1", size: 8, x: chartX + chartW - 70, y: chartY - 12, text: run.payload.dates[run.payload.dates.length - 1] ?? "" }));
    ops.push(text({ font: "F1", size: 8, x: chartX, y: chartY - 12, text: run.payload.dates[0] ?? "" }));
  }

  // Regime distribution bars.
  const distTop = chartY - 40;
  ops.push(setFill([0.13, 0.16, 0.22]));
  ops.push(text({ font: "F2", size: 12, x: M, y: distTop, text: "Regime distribution" }));

  const total = Object.values(counts).reduce((a, b) => a + (b as number), 0) || 1;
  const entries = Object.entries(counts).sort((a, b) => (b[1] as number) - (a[1] as number));
  const barY = distTop - 28;
  const barH = 22;
  let bx = M;
  const barTotalW = W - 2 * M;
  for (const [label, c] of entries) {
    const w = ((c as number) / total) * barTotalW;
    ops.push(setFill(color(label)));
    ops.push(rect(bx, barY - barH, w, barH), "f");
    bx += w;
  }
  // Legend.
  let legX = M;
  const legY = barY - barH - 22;
  for (const [label, c] of entries) {
    const pct = `${Math.round(((c as number) / total) * 100)}%`;
    ops.push(setFill(color(label)));
    ops.push(rect(legX, legY, 10, 10), "f");
    ops.push(setFill([0.13, 0.16, 0.22]));
    ops.push(text({ font: "F1", size: 10, x: legX + 16, y: legY + 1, text: `${label} ${pct}` }));
    legX += 110;
  }

  // Tags.
  if (run.tags && run.tags.length > 0) {
    ops.push(setFill([0.42, 0.46, 0.54]));
    ops.push(text({ font: "F1", size: 9, x: M, y: legY - 22, text: `tags: ${run.tags.map((t) => `#${t}`).join("  ")}` }));
  }

  // Notes (single line, truncated).
  if (run.notes && run.notes.trim().length > 0) {
    const note = run.notes.replace(/\s+/g, " ").slice(0, 180);
    ops.push(setFill([0.30, 0.34, 0.42]));
    ops.push(text({ font: "F1", size: 9, x: M, y: legY - 38, text: `notes: ${note}` }));
  }

  // Footer.
  ops.push(setFill([0.54, 0.58, 0.66]));
  ops.push(text({ font: "F1", size: 8, x: M, y: 36, text: "Not investment advice. Educational use only." }));
  ops.push(text({ font: "F1", size: 8, x: W - M - 160, y: 36, text: `signalclaw /r/${run.id}` }));

  // Assemble PDF.
  const contentStream = ops.join("\n");
  const stream = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>"); // 1
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); // 2
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
  ); // 3
  objects.push(stream); // 4
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 5
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"); // 6

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  // Use Buffer-style length tracking via TextEncoder for accuracy.
  const enc = new TextEncoder();
  let cursor = enc.encode(pdf).length;
  const parts: Uint8Array[] = [enc.encode(pdf)];
  objects.forEach((body, i) => {
    offsets.push(cursor);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    const bytes = enc.encode(chunk);
    parts.push(bytes);
    cursor += bytes.length;
  });

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  parts.push(enc.encode(xref + trailer));

  // Concat.
  const total2 = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total2);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function pdfFilename(run: SavedRun): string {
  const safeTicker = (run.ticker || "run").replace(/[^A-Za-z0-9_-]/g, "_");
  const dt = new Date(run.created_at).toISOString().slice(0, 10);
  return `signalclaw_${safeTicker}_${dt}_${run.id.slice(0, 8)}.pdf`;
}
