// Webhook delivery export helpers. Pure, no I/O; used by the
// /api/webhooks/deliveries route and unit tested in
// tests/webhookDeliveriesExport.test.mjs.

import type { DeliveryAttempt } from "./webhookStore";

// Spreadsheet apps (Excel, Numbers, LibreOffice, Google Sheets) treat a cell
// whose first character is one of = + - @ \t \r as a formula. Webhook URLs
// and error strings are operator-supplied so a row like
// `=HYPERLINK("http://evil","click")` could execute on import. Prefix such
// cells with a single quote, which spreadsheets strip on display but which
// neutralises the formula. Mirrors lib/journalExport.ts.
function csvEscape(v: string): string {
  if (v === "") return "";
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(v);
  const guarded = needsFormulaGuard ? `'${v}` : v;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

export function deliveriesToCSV(deliveries: DeliveryAttempt[]): string {
  const header =
    "delivered_at,subscription_id,url,status,attempt,event_count,replay_of,error";
  const lines = deliveries.map((d) =>
    [
      d.delivered_at,
      csvEscape(d.subscription_id),
      csvEscape(d.url),
      d.status === null ? "" : String(d.status),
      String(d.attempt),
      String(d.event_count),
      csvEscape(d.replay_of ?? ""),
      csvEscape(d.error ?? ""),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export function deliveriesToJSON(deliveries: DeliveryAttempt[]): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: deliveries.length,
    deliveries,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}
