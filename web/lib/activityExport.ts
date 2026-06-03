// Activity event export helpers. Pure, no I/O; used by the /activity
// "Download CSV/JSON" buttons and unit tested in tests/activityExport.test.mjs.
//
// Events are sorted by created_at descending (most recent first) so the
// spreadsheet matches what the page shows. CSV cells containing a comma,
// quote, or newline are quoted per RFC 4180. Cells whose first character is
// =, +, -, @, tab, or CR are prefixed with a single quote to neutralise
// spreadsheet formula injection (the title/body fields can contain arbitrary
// user content like webhook payload snippets).

export type ActivityEventLite = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  created_at: string;
  read: boolean;
};

function csvCell(v: string): string {
  if (v === "") return "";
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function sortedEvents(rows: ActivityEventLite[]): ActivityEventLite[] {
  return rows.slice().sort((a, b) => {
    const byTime = (b.created_at || "").localeCompare(a.created_at || "");
    if (byTime !== 0) return byTime;
    return (a.id || "").localeCompare(b.id || "");
  });
}

export function activityEventsToCSV(rows: ActivityEventLite[]): string {
  const lines: string[] = [];
  lines.push("created_at,kind,title,body,href,read,id");
  for (const r of sortedEvents(rows)) {
    lines.push(
      [
        csvCell(r.created_at ?? ""),
        csvCell(r.kind ?? ""),
        csvCell(r.title ?? ""),
        csvCell(r.body ?? ""),
        csvCell(r.href ?? ""),
        r.read ? "true" : "false",
        csvCell(r.id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function activityEventsToJSON(rows: ActivityEventLite[]): string {
  return JSON.stringify({ events: sortedEvents(rows) }, null, 2) + "\n";
}

export function activityFilename(
  kind: string,
  unreadOnly: boolean,
  ext: "csv" | "json",
): string {
  const parts = ["activity"];
  const k = (kind || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (k) parts.push(k);
  if (unreadOnly) parts.push("unread");
  return `${parts.join("-")}.${ext}`;
}
