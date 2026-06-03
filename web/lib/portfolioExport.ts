// Portfolio positions export helpers. Pure, no I/O. Mirrors the CSV/JSON
// shape used by /journal and /alerts so positions snapshots can be pulled
// into spreadsheets, trade reviews, or external risk tools without copy-paste.
// Unit tested in tests/portfolioExport.test.mjs.

export type PositionLite = {
  ticker: string;
  quantity: number;
  avg_cost: number;
  last_price: number | null;
  market_value: number;
  cost: number;
  unrealized_pnl: number;
  unrealized_pct: number;
  realized_pnl: number;
};

export type PortfolioSnapshotLite = {
  positions: PositionLite[];
  total_cost: number;
  total_market_value: number;
  total_unrealized: number;
  total_realized: number;
  weights: Record<string, number>;
};

function csvEscape(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function num(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "";
  return String(v);
}

function weightOf(snap: PortfolioSnapshotLite, p: PositionLite): number {
  const w = snap.weights?.[p.ticker];
  if (typeof w === "number") return w;
  if (snap.total_market_value > 0) return p.market_value / snap.total_market_value;
  return 0;
}

export function positionsToCSV(snap: PortfolioSnapshotLite): string {
  const header =
    "ticker,quantity,avg_cost,last_price,market_value,cost,weight,unrealized_pnl,unrealized_pct,realized_pnl";
  const lines = snap.positions.map((p) =>
    [
      csvEscape(p.ticker),
      num(p.quantity),
      num(p.avg_cost),
      num(p.last_price),
      num(p.market_value),
      num(p.cost),
      num(weightOf(snap, p)),
      num(p.unrealized_pnl),
      num(p.unrealized_pct),
      num(p.realized_pnl),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export function positionsToJSON(snap: PortfolioSnapshotLite): string {
  const payload = {
    exported_at: new Date().toISOString(),
    count: snap.positions.length,
    totals: {
      cost: snap.total_cost,
      market_value: snap.total_market_value,
      unrealized: snap.total_unrealized,
      realized: snap.total_realized,
    },
    positions: snap.positions.map((p) => ({
      ...p,
      weight: weightOf(snap, p),
    })),
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "";
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * Render the positions snapshot as a Markdown report (header + totals block +
 * positions table). Mirrors the shape of `entriesToMarkdown` in journalExport
 * so a trader can paste a portfolio snapshot into a trade review doc the same
 * way they paste journal entries.
 */
export function positionsToMarkdown(snap: PortfolioSnapshotLite): string {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const count = snap.positions.length;
  const head = [
    `# SignalClaw portfolio`,
    ``,
    `Exported ${stamp} \u00b7 ${count} position${count === 1 ? "" : "s"}`,
    ``,
    `- Market value: ${fmtUsd(snap.total_market_value)}`,
    `- Cost basis: ${fmtUsd(snap.total_cost)}`,
    `- Unrealized: ${fmtUsd(snap.total_unrealized)}` +
      (snap.total_cost > 0
        ? ` (${fmtPct(snap.total_unrealized / snap.total_cost)})`
        : ""),
    `- Realized: ${fmtUsd(snap.total_realized)}`,
    ``,
  ];
  if (count === 0) {
    return head.concat([`_No open positions._`, ``]).join("\n");
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const table = [
    `| Ticker | Qty | Avg | Mark | Mkt val | Weight | P&L | P&L % | Realized |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const p of snap.positions) {
    table.push(
      `| ${esc(p.ticker)} | ${p.quantity} | ${fmtUsd(p.avg_cost)} | ${
        p.last_price == null ? "--" : fmtUsd(p.last_price)
      } | ${fmtUsd(p.market_value)} | ${fmtPct(weightOf(snap, p))} | ${fmtUsd(
        p.unrealized_pnl,
      )} | ${fmtPct(p.unrealized_pct)} | ${fmtUsd(p.realized_pnl)} |`,
    );
  }
  return head.concat(table, [""]).join("\n");
}

export function portfolioExportFilename(ext: "csv" | "json" | "md"): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `signalclaw-portfolio-${stamp}.${ext}`;
}
