// Pure helpers for /api/runs/export and /api/v1/runs/export.
//
// Both routes must honor the same filters as /api/runs (q, regime, ticker,\n// tag, pinned). Centralizing the parsing here keeps the two routes in sync\n// and lets the parsing be unit-tested without booting Next.
import type { QueryOpts } from "./runStore";

export type ExportFormat = "csv" | "json" | "md";

export const EXPORT_MAX_LIMIT = 200;
export const EXPORT_DEFAULT_LIMIT = 200;

export function parseExportFormat(raw: string | null | undefined): ExportFormat | null {
  const f = (raw ?? "csv").toLowerCase();
  if (f === "csv" || f === "json" || f === "md") return f;
  if (f === "markdown") return "md";
  return null;
}

export function parseExportLimit(raw: string | null | undefined): number {
  const n = Number.parseInt(raw ?? String(EXPORT_DEFAULT_LIMIT), 10);
  const v = Number.isFinite(n) && n > 0 ? n : EXPORT_DEFAULT_LIMIT;
  return Math.min(Math.max(v, 1), EXPORT_MAX_LIMIT);
}

export function parseMinConfidence(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // Accept either a fraction in [0, 1] (e.g. "0.75") or a percent in (1, 100]
  // (e.g. "75" or "75%"). UI commonly types percents; API callers commonly
  // pass fractions. Out-of-range or unparseable values are ignored.
  const pct = s.endsWith("%");
  const n = Number.parseFloat(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return undefined;
  const frac = pct || n > 1 ? n / 100 : n;
  if (!Number.isFinite(frac) || frac < 0 || frac > 1) return undefined;
  return frac;
}

// Same parsing rules as parseMinConfidence. Kept as a separate symbol so call
// sites read clearly and so we can evolve the upper-bound behavior
// independently later (for example, clamping max to never fall below min).
export function parseMaxConfidence(raw: string | null | undefined): number | undefined {
  return parseMinConfidence(raw);
}

// Parse a min_bars query param. Accepts non-negative integers ("50",
// "  100 "). Floating values are floored. Negative, non-finite, or
// unparseable values are ignored so the filter degrades to a no-op, matching
// the lenient policy of the other run filters.
export function parseMinBars(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

// Same parsing rules as parseMinBars. Kept as a separate symbol so call
// sites read clearly and so we can evolve the upper-bound behavior
// independently later (for example, clamping max to never fall below min).
// Pairs with parseMinBars to bracket a bar-count window (e.g. show only
// runs with 50-200 bars).
export function parseMaxBars(raw: string | null | undefined): number | undefined {
  return parseMinBars(raw);
}

export function parseExportQuery(sp: URLSearchParams): Omit<QueryOpts, "ownerFilter"> {
  const pinnedRaw = sp.get("pinned");
  const pinnedOnly = pinnedRaw === "1" || pinnedRaw === "true";
  const since = (sp.get("since") ?? "").trim();
  const until = (sp.get("until") ?? "").trim();
  const sortRaw = (sp.get("sort") ?? "").toLowerCase();
  const sort: QueryOpts["sort"] =
    sortRaw === "oldest" ||
    sortRaw === "ticker" ||
    sortRaw === "confidence" ||
    sortRaw === "bars"
      ? (sortRaw as NonNullable<QueryOpts["sort"]>)
      : "recent";
  return {
    q: sp.get("q") ?? "",
    regime: sp.get("regime") ?? "",
    ticker: sp.get("ticker") ?? "",
    tag: sp.get("tag") ?? "",
    pinned: pinnedOnly ? true : undefined,
    since: since || undefined,
    until: until || undefined,
    minConfidence: parseMinConfidence(sp.get("min_confidence")),
    maxConfidence: parseMaxConfidence(sp.get("max_confidence")),
    minBars: parseMinBars(sp.get("min_bars")),
    maxBars: parseMaxBars(sp.get("max_bars")),
    sort,
    limit: parseExportLimit(sp.get("limit")),
    offset: 0,
  };
}

export function exportHeaders(total: number, exported: number, format: ExportFormat): Record<string, string> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const ext = format === "json" ? "json" : format === "md" ? "md" : "csv";
  const contentType =
    format === "json"
      ? "application/json; charset=utf-8"
      : format === "md"
        ? "text/markdown; charset=utf-8"
        : "text/csv; charset=utf-8";
  return {
    "x-total-count": String(total),
    "x-exported-count": String(exported),
    "x-truncated": exported < total ? "1" : "0",
    "content-type": contentType,
    "content-disposition": `attachment; filename="signalclaw-runs-${stamp}.${ext}"`,
  };
}
