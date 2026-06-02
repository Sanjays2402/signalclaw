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

export function exportFilename(ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `signalclaw-journal-${stamp}.${ext}`;
}
