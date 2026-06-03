// Journal export helpers. Pure, no I/O; used by /journal export buttons
// and unit tested in tests/journalExport.test.mjs.

export type JournalEntryLite = {
  trade_id: string;
  thesis: string;
  conviction: number;
  tags: string[];
  exit_reason: string | null;
  created_at: string;
  updated_at: string;
};

// Spreadsheet apps (Excel, Numbers, LibreOffice, Google Sheets) treat a cell
// whose first character is one of = + - @ \t \r as a formula. Because
// thesis/tags/exit_reason are operator-supplied free text, a row like
// `=HYPERLINK("http://evil","click")` in a thesis would execute on import.
// Prefix such cells with a single quote, which spreadsheets strip on display
// but which neutralises the formula. Re-importers that split on comma still
// see the original text minus the leading sentinel.
function csvEscape(v: string): string {
  if (v === "") return "";
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(v);
  const guarded = needsFormulaGuard ? `'${v}` : v;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function entriesToCSV(entries: JournalEntryLite[]): string {
  const header =
    "trade_id,created_at,updated_at,conviction,exit_reason,tags,thesis";
  const lines = entries.map((e) =>
    [
      csvEscape(e.trade_id),
      e.created_at ?? "",
      e.updated_at ?? "",
      String(e.conviction ?? ""),
      csvEscape(e.exit_reason ?? ""),
      csvEscape((e.tags ?? []).join("|")),
      csvEscape(e.thesis ?? ""),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export function entriesToJSON(entries: JournalEntryLite[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

// Markdown export mirrors the CSV columns as a GitHub-flavored table so the
// journal can be pasted into a trade review doc, an issue, or a chat the same
// way /watchlist and /history already support.
export function entriesToMarkdown(entries: JournalEntryLite[]): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const head = [
    `# SignalClaw journal`,
    ``,
    `Exported ${stamp} \u00b7 ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    ``,
  ];
  if (entries.length === 0) {
    return head.concat([`_No journal entries yet._`, ``]).join("\n");
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const table = [
    `| Trade ID | Updated | Conviction | Exit reason | Tags | Thesis |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const e of entries) {
    const updated = (e.updated_at || "").slice(0, 10);
    const tags = (e.tags ?? []).join(", ");
    table.push(
      `| ${esc(e.trade_id ?? "")} | ${updated} | ${e.conviction ?? ""}/5 | ${esc(e.exit_reason ?? "")} | ${esc(tags)} | ${esc(e.thesis ?? "")} |`,
    );
  }
  return head.concat(table, [""]).join("\n");
}

/**
 * Pure URL <-> filter state helpers for /journal. Used so the address bar
 * mirrors active filters (shareable links) and reloads restore the view.
 */
/**
 * Sort order for the visible journal list. Default is the most recently
 * updated entry first, matching how the API has historically returned data.
 */
export type JournalSort =
  | "updated_desc"
  | "updated_asc"
  | "conviction_desc"
  | "conviction_asc"
  | "trade_id_asc";

export const JOURNAL_SORT_DEFAULT: JournalSort = "updated_desc";

const JOURNAL_SORTS: readonly JournalSort[] = [
  "updated_desc",
  "updated_asc",
  "conviction_desc",
  "conviction_asc",
  "trade_id_asc",
];

export type JournalUrlState = {
  query: string;
  conviction: "" | "1" | "2" | "3" | "4" | "5";
  tag: string;
  /** Inclusive lower bound on updated_at, formatted YYYY-MM-DD. Empty means unset. */
  since: string;
  /** Inclusive upper bound on updated_at, formatted YYYY-MM-DD. Empty means unset. */
  until: string;
  /** Visible sort order. Defaults to updated_desc when absent or invalid. */
  sort: JournalSort;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDateParam(raw: string | null): string {
  if (!raw) return "";
  const v = raw.slice(0, 10);
  return ISO_DATE_RE.test(v) ? v : "";
}

export function parseJournalUrlState(
  search: string | URLSearchParams,
): JournalUrlState {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  const q = (sp.get("q") ?? "").slice(0, 200);
  const rawConv = sp.get("conviction") ?? "";
  const conv: JournalUrlState["conviction"] = /^[1-5]$/.test(rawConv)
    ? (rawConv as JournalUrlState["conviction"])
    : "";
  const tag = (sp.get("tag") ?? "").slice(0, 64);
  const since = normalizeDateParam(sp.get("since"));
  const until = normalizeDateParam(sp.get("until"));
  const rawSort = sp.get("sort") ?? "";
  const sort: JournalSort = (JOURNAL_SORTS as readonly string[]).includes(rawSort)
    ? (rawSort as JournalSort)
    : JOURNAL_SORT_DEFAULT;
  return { query: q, conviction: conv, tag, since, until, sort };
}

export function serializeJournalUrlState(state: JournalUrlState): string {
  const sp = new URLSearchParams();
  if (state.query) sp.set("q", state.query);
  if (state.conviction) sp.set("conviction", state.conviction);
  if (state.tag) sp.set("tag", state.tag);
  if (state.since) sp.set("since", state.since);
  if (state.until) sp.set("until", state.until);
  if (state.sort && state.sort !== JOURNAL_SORT_DEFAULT) sp.set("sort", state.sort);
  return sp.toString();
}

/**
 * Pure stable sort over journal entries. Returns a new array and does not
 * mutate the input. Ties fall back to trade_id ascending so the order stays
 * deterministic across renders.
 */
export function sortEntries(
  entries: JournalEntryLite[],
  sort: JournalSort = JOURNAL_SORT_DEFAULT,
): JournalEntryLite[] {
  const out = entries.slice();
  const byTradeId = (a: JournalEntryLite, b: JournalEntryLite) =>
    (a.trade_id ?? "").localeCompare(b.trade_id ?? "");
  const byUpdated = (dir: 1 | -1) => (a: JournalEntryLite, b: JournalEntryLite) => {
    const av = a.updated_at ?? "";
    const bv = b.updated_at ?? "";
    if (av === bv) return byTradeId(a, b);
    return av < bv ? -dir : dir;
  };
  const byConviction = (dir: 1 | -1) => (a: JournalEntryLite, b: JournalEntryLite) => {
    const av = Number.isFinite(a.conviction) ? a.conviction : -Infinity;
    const bv = Number.isFinite(b.conviction) ? b.conviction : -Infinity;
    if (av === bv) return byTradeId(a, b);
    return av < bv ? -dir : dir;
  };
  switch (sort) {
    case "updated_asc": out.sort(byUpdated(1)); break;
    case "conviction_desc": out.sort(byConviction(-1)); break;
    case "conviction_asc": out.sort(byConviction(1)); break;
    case "trade_id_asc": out.sort(byTradeId); break;
    case "updated_desc":
    default: out.sort(byUpdated(-1)); break;
  }
  return out;
}

export type JournalFilter = {
  /** Free text. Matches trade_id, thesis, exit_reason, or any tag. Case insensitive. */
  query?: string;
  /** Optional exact-match conviction (1..5). Anything else means no conviction filter. */
  conviction?: number | null;
  /** Optional exact-match tag (case insensitive). Entry must have a tag equal to this. */
  tag?: string | null;
  /** Inclusive lower bound on the entry's updated_at date (YYYY-MM-DD). Invalid = ignored. */
  since?: string | null;
  /** Inclusive upper bound on the entry's updated_at date (YYYY-MM-DD). Invalid = ignored. */
  until?: string | null;
};

/**
 * Pure filter over journal entries. Empty / missing filter returns the input as-is.
 * Used by /journal so the visible list and export buttons stay in sync.
 */
export function filterEntries(
  entries: JournalEntryLite[],
  filter: JournalFilter,
): JournalEntryLite[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  const conv =
    typeof filter.conviction === "number" &&
    Number.isFinite(filter.conviction) &&
    filter.conviction >= 1 &&
    filter.conviction <= 5
      ? filter.conviction
      : null;
  const tag = (filter.tag ?? "").trim().toLowerCase();
  const sinceRaw = (filter.since ?? "").trim();
  const untilRaw = (filter.until ?? "").trim();
  const since = ISO_DATE_RE.test(sinceRaw) ? sinceRaw : "";
  const until = ISO_DATE_RE.test(untilRaw) ? untilRaw : "";
  if (!q && conv === null && !tag && !since && !until) return entries;
  return entries.filter((e) => {
    if (conv !== null && e.conviction !== conv) return false;
    if (tag) {
      const tags = (e.tags ?? []).map((t) => t.toLowerCase());
      if (!tags.includes(tag)) return false;
    }
    if (since || until) {
      const day = (e.updated_at ?? "").slice(0, 10);
      if (!ISO_DATE_RE.test(day)) return false;
      if (since && day < since) return false;
      if (until && day > until) return false;
    }
    if (!q) return true;
    if ((e.trade_id ?? "").toLowerCase().includes(q)) return true;
    if ((e.thesis ?? "").toLowerCase().includes(q)) return true;
    if ((e.exit_reason ?? "").toLowerCase().includes(q)) return true;
    for (const t of e.tags ?? []) {
      if (t.toLowerCase().includes(q)) return true;
    }
    return false;
  });
}

/**
 * Sorted, deduped list of tags across the given entries. Stable case (first-seen
 * casing wins). Useful to populate a tag filter dropdown on /journal.
 */
export function collectTags(entries: JournalEntryLite[]): string[] {
  const seen = new Map<string, string>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, t.trim());
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

export function exportFilename(ext: "csv" | "json" | "md"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `signalclaw-journal-${stamp}.${ext}`;
}
