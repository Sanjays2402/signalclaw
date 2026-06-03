// Diversification export helpers. Pure, no I/O; used by the /diversification
// "Download CSV/JSON" buttons and unit tested in tests/diversificationExport.test.mjs.
//
// The CSV is shaped for an analyst pasting into a spreadsheet: a small summary
// header section, then one row per cluster with its members joined by spaces,
// then any warnings as their own rows. JSON mirrors the raw API payload so a
// script can round-trip it without reparsing the CSV.

export type DiversificationLite = {
  window: number;
  threshold: number;
  n_tickers: number;
  avg_pairwise_corr: number;
  max_pairwise_corr: number;
  most_correlated_pair: string[] | null;
  clusters: string[][];
  warnings: string[];
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

export function diversificationToCSV(data: DiversificationLite): string {
  const pair = Array.isArray(data.most_correlated_pair) ? data.most_correlated_pair.join(" / ") : "";
  const clusters = Array.isArray(data.clusters) ? data.clusters : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const lines: string[] = [];

  lines.push("section,key,value");
  lines.push(`summary,window,${data.window}`);
  lines.push(`summary,threshold,${fmtNum(data.threshold)}`);
  lines.push(`summary,n_tickers,${data.n_tickers}`);
  lines.push(`summary,avg_pairwise_corr,${fmtNum(data.avg_pairwise_corr)}`);
  lines.push(`summary,max_pairwise_corr,${fmtNum(data.max_pairwise_corr)}`);
  lines.push(`summary,most_correlated_pair,${csvCell(pair)}`);

  lines.push("");
  lines.push("cluster_index,size,members");
  for (let i = 0; i < clusters.length; i++) {
    const members = clusters[i] ?? [];
    lines.push(`${i + 1},${members.length},${csvCell(members.join(" "))}`);
  }

  lines.push("");
  lines.push("warning_index,message");
  for (let i = 0; i < warnings.length; i++) {
    lines.push(`${i + 1},${csvCell(warnings[i])}`);
  }

  return lines.join("\n") + "\n";
}

export function diversificationToJSON(data: DiversificationLite): string {
  return JSON.stringify(
    {
      window: data.window,
      threshold: data.threshold,
      n_tickers: data.n_tickers,
      avg_pairwise_corr: data.avg_pairwise_corr,
      max_pairwise_corr: data.max_pairwise_corr,
      most_correlated_pair: data.most_correlated_pair ?? null,
      clusters: Array.isArray(data.clusters) ? data.clusters : [],
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
    },
    null,
    2,
  );
}

export function diversificationFilename(window: number, threshold: number, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const w = Number.isFinite(window) ? window : 0;
  const t = Number.isFinite(threshold) ? threshold.toFixed(2) : "0.00";
  return `signalclaw-diversification-w${w}-t${t}-${stamp}.${ext}`;
}
