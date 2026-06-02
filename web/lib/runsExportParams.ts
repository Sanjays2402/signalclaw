// Pure helpers for /api/runs/export and /api/v1/runs/export.
//
// Both routes must honor the same filters as /api/runs (q, regime, ticker,\n// tag, pinned). Centralizing the parsing here keeps the two routes in sync\n// and lets the parsing be unit-tested without booting Next.
import type { QueryOpts } from "./runStore";

export type ExportFormat = "csv" | "json";

export const EXPORT_MAX_LIMIT = 200;
export const EXPORT_DEFAULT_LIMIT = 200;

export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  const f = (raw ?? "csv").toLowerCase();
  return f === "csv" || f === "json" ? f : null;
}

export function parseExportLimit(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? String(EXPORT_DEFAULT_LIMIT), 10);
  const v = Number.isFinite(n) && n > 0 ? n : EXPORT_DEFAULT_LIMIT;
  return Math.min(Math.max(v, 1), EXPORT_MAX_LIMIT);
}

export function parseExportQuery(sp: URLSearchParams): Omit<QueryOpts, "ownerFilter"> {
  const pinnedRaw = sp.get("pinned");
  const pinnedOnly = pinnedRaw === "1" || pinnedRaw === "true";
  return {
    q: sp.get("q") ?? "",
    regime: sp.get("regime") ?? "",
    ticker: sp.get("ticker") ?? "",
    tag: sp.get("tag") ?? "",
    pinned: pinnedOnly ? true : undefined,
    limit: parseExportLimit(sp.get("limit")),
    offset: 0,
  };
}

export function exportHeaders(total: number, exported: number, format: ExportFormat): Record<string, string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = format === "json" ? "json" : "csv";
  const contentType =
    format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8";
  return {
    "x-total-count": String(total),
    "x-exported-count": String(exported),
    "x-truncated": exported < total ? "1" : "0",
    "content-type": contentType,
    "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.${ext}"`,
  };
}
