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

function csvEscape(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
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
export type JournalUrlState = {
  query: string;
  conviction: "" | "1" | "2" | "3" | "4" | "5";
  tag: string;
};

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
  return { query: q, conviction: conv, tag };
}

export function serializeJournalUrlState(state: JournalUrlState): string {
  const sp = new URLSearchParams();
  if (state.query) sp.set("q", state.query);
  if (state.conviction) sp.set("conviction", state.conviction);
  if (state.tag) sp.set("tag", state.tag);
  return sp.toString();
}

export type JournalFilter = {
  /** Free text. Matches trade_id, thesis, exit_reason, or any tag. Case insensitive. */
  query?: string;
  /** Optional exact-match conviction (1..5). Anything else means no conviction filter. */
  conviction?: number | null;
  /** Optional exact-match tag (case insensitive). Entry must have a tag equal to this. */
  tag?: string | null;
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
  if (!q && conv === null && !tag) return entries;
  return entries.filter((e) => {
    if (conv !== null && e.conviction !== conv) return false;
    if (tag) {
      const tags = (e.tags ?? []).map((t) => t.toLowerCase());
      if (!tags.includes(tag)) return false;
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
