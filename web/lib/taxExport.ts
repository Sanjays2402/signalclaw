// Tax export helpers. Pure, no I/O; used by the /tax "Download CSV/JSON"
// buttons and unit tested in tests/taxExport.test.mjs.
//
// Realized events are sorted by sell_date ascending then ticker so the
// spreadsheet view matches typical tax workpaper ordering. CSV escapes any
// field containing a comma, quote, or newline; JSON mirrors the API payload
// (events + wash sales + totals) so a script can round-trip the full report.

export type TaxEventLite = {
  ticker: string;
  sell_trade_id: string;
  sell_date: string;
  quantity: number;
  proceeds: number;
  cost_basis: number;
  realized_pnl: number;
  lot_acquired: string | null;
  holding_days: number | null;
  long_term: boolean | null;
};

export type WashSaleLite = {
  ticker: string;
  sell_trade_id: string;
  sell_date: string;
  loss: number;
  triggering_buy_id: string;
  triggering_buy_date: string;
  days_between: number;
};

export type TaxReportLite = {
  method: string;
  events: TaxEventLite[];
  realized_total: number;
  realized_short_term: number;
  realized_long_term: number;
  wash_sales: WashSaleLite[];
};

function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "";
  // Match the on-page precision: 4 dp for quantity, 2 dp for money.
  return n.toString();
}

function sortedEvents(rows: TaxEventLite[]): TaxEventLite[] {
  return rows.slice().sort((a, b) => {
    const byDate = (a.sell_date || "").localeCompare(b.sell_date || "");
    if (byDate !== 0) return byDate;
    const byTicker = (a.ticker || "").localeCompare(b.ticker || "");
    if (byTicker !== 0) return byTicker;
    return (a.sell_trade_id || "").localeCompare(b.sell_trade_id || "");
  });
}

function sortedWashSales(rows: WashSaleLite[]): WashSaleLite[] {
  return rows.slice().sort((a, b) => {
    const byDate = (a.sell_date || "").localeCompare(b.sell_date || "");
    if (byDate !== 0) return byDate;
    return (a.ticker || "").localeCompare(b.ticker || "");
  });
}

export function taxEventsToCSV(rows: TaxEventLite[]): string {
  const lines: string[] = [];
  lines.push(
    "sell_date,ticker,quantity,proceeds,cost_basis,realized_pnl,holding_days,long_term,lot_acquired,sell_trade_id",
  );
  for (const r of sortedEvents(rows)) {
    lines.push(
      [
        csvCell(r.sell_date ?? ""),
        csvCell(r.ticker ?? ""),
        num(r.quantity),
        num(r.proceeds),
        num(r.cost_basis),
        num(r.realized_pnl),
        r.holding_days == null ? "" : String(r.holding_days),
        r.long_term == null ? "" : r.long_term ? "true" : "false",
        csvCell(r.lot_acquired ?? ""),
        csvCell(r.sell_trade_id ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function taxReportToJSON(report: TaxReportLite): string {
  return JSON.stringify(
    {
      method: report.method,
      totals: {
        realized_total: report.realized_total,
        realized_short_term: report.realized_short_term,
        realized_long_term: report.realized_long_term,
      },
      events: sortedEvents(report.events).map((e) => ({
        sell_date: e.sell_date,
        ticker: e.ticker,
        quantity: e.quantity,
        proceeds: e.proceeds,
        cost_basis: e.cost_basis,
        realized_pnl: e.realized_pnl,
        holding_days: e.holding_days,
        long_term: e.long_term,
        lot_acquired: e.lot_acquired,
        sell_trade_id: e.sell_trade_id,
      })),
      wash_sales: sortedWashSales(report.wash_sales).map((w) => ({
        sell_date: w.sell_date,
        ticker: w.ticker,
        loss: w.loss,
        triggering_buy_date: w.triggering_buy_date,
        days_between: w.days_between,
        sell_trade_id: w.sell_trade_id,
        triggering_buy_id: w.triggering_buy_id,
      })),
    },
    null,
    2,
  );
}

export function taxFilename(method: string, washWindow: number, ext: "csv" | "json"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const m = (method || "fifo").toLowerCase().replace(/[^a-z0-9]/g, "");
  return `signalclaw-tax-${m}-w${washWindow}-${stamp}.${ext}`;
}
