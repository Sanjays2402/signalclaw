// Rotation export helpers. Pure, no I/O; used by the /rotation "Download
// CSV/JSON" buttons and unit tested in tests/rotationExport.test.mjs.
//
// CSV is shaped for an analyst pasting into a spreadsheet: a small summary
// header section (benchmark, as_of, counts), then one row per sector sorted by
// composite descending with all the headline metrics, then a small "skipped"
// section so the export records what was excluded and why. JSON mirrors the
// raw API payload so a script can round-trip it without reparsing the CSV.

export type SectorScoreLite = {
  sector: string;
  n_tickers: number;
  ret_1m: number;
  ret_3m: number;
  ret_6m: number;
  rs_slope: number;
  breadth: number;
  composite: number;
  call: string;
  members: string[];
};

export type RotationReportLite = {
  benchmark: string;
  asof: string;
  overweight: string[];
  underweight: string[];
  scores: SectorScoreLite[];
  skipped_unknown_sector: string[];
  skipped_short_history: string[];
};

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function fmtNum(v: number, decimals = 4): string {
  if (!Number.isFinite(v)) return "";
  return v.toFixed(decimals);
}

export function rotationToCSV(data: RotationReportLite): string {
  const scores = Array.isArray(data.scores) ? data.scores : [];
  const overweight = Array.isArray(data.overweight) ? data.overweight : [];
  const underweight = Array.isArray(data.underweight) ? data.underweight : [];
  const skippedUnknown = Array.isArray(data.skipped_unknown_sector) ? data.skipped_unknown_sector : [];
  const skippedShort = Array.isArray(data.skipped_short_history) ? data.skipped_short_history : [];
  const sorted = [...scores].sort((a, b) => b.composite - a.composite);
  const lines: string[] = [];

  lines.push("section,key,value");
  lines.push(`summary,benchmark,${csvCell(data.benchmark ?? "")}`);
  lines.push(`summary,as_of,${csvCell(data.asof ?? "")}`);
  lines.push(`summary,n_sectors,${scores.length}`);
  lines.push(`summary,overweight,${csvCell(overweight.join(" "))}`);
  lines.push(`summary,underweight,${csvCell(underweight.join(" "))}`);

  lines.push("");
  lines.push("rank,sector,call,composite,ret_1m,ret_3m,ret_6m,rs_slope,breadth,n_tickers,members");
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const members = Array.isArray(s.members) ? s.members : [];
    lines.push(
      [
        i + 1,
        csvCell(s.sector ?? ""),
        csvCell(s.call ?? ""),
        fmtNum(s.composite),
        fmtNum(s.ret_1m),
        fmtNum(s.ret_3m),
        fmtNum(s.ret_6m),
        fmtNum(s.rs_slope),
        fmtNum(s.breadth),
        s.n_tickers,
        csvCell(members.join(" ")),
      ].join(","),
    );
  }

  lines.push("");
  lines.push("skipped_reason,tickers");
  lines.push(`unknown_sector,${csvCell(skippedUnknown.join(" "))}`);
  lines.push(`short_history,${csvCell(skippedShort.join(" "))}`);

  return lines.join("\n") + "\n";
}

export function rotationToJSON(data: RotationReportLite): string {
  return JSON.stringify(
    {
      benchmark: data.benchmark,
      asof: data.asof,
      overweight: Array.isArray(data.overweight) ? data.overweight : [],
      underweight: Array.isArray(data.underweight) ? data.underweight : [],
      scores: Array.isArray(data.scores) ? data.scores : [],
      skipped_unknown_sector: Array.isArray(data.skipped_unknown_sector) ? data.skipped_unknown_sector : [],
      skipped_short_history: Array.isArray(data.skipped_short_history) ? data.skipped_short_history : [],
    },
    null,
    2,
  );
}

export function rotationFilename(benchmark: string, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const safe = (benchmark || "BENCH").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `signalclaw-rotation-${safe}-${stamp}.${ext}`;
}
