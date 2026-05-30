"use client";
import useSWR from "swr";
import { swrFetcher, type PortfolioSnapshot } from "@/lib/api";

// Seed positions used when API is empty or unauthenticated.
const SEED = [
  { ticker: "SPY", last: 612.40, chg: 0.0042 },
  { ticker: "QQQ", last: 548.21, chg: 0.0061 },
  { ticker: "AAPL", last: 232.18, chg: -0.0034 },
  { ticker: "NVDA", last: 138.92, chg: 0.0218 },
  { ticker: "MSFT", last: 458.10, chg: 0.0011 },
  { ticker: "TSLA", last: 348.55, chg: -0.0182 },
  { ticker: "AMZN", last: 224.07, chg: 0.0089 },
  { ticker: "META", last: 612.83, chg: 0.0044 },
  { ticker: "GOOGL", last: 198.40, chg: -0.0019 },
  { ticker: "AMD", last: 145.21, chg: 0.0312 },
  { ticker: "BTC", last: 96850.00, chg: 0.0125 },
  { ticker: "ETH", last: 3420.50, chg: -0.0067 },
];

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number) {
  const s = n >= 0 ? "+" : "";
  return `${s}${(n * 100).toFixed(2)}%`;
}

export default function TickerTape() {
  const { data } = useSWR<PortfolioSnapshot>("/portfolio/snapshot", swrFetcher, {
    refreshInterval: 30000,
    shouldRetryOnError: false,
  });

  let items = SEED;
  if (data?.positions && data.positions.length > 0) {
    items = data.positions
      .filter((p) => p.last_price != null)
      .map((p) => ({
        ticker: p.ticker,
        last: p.last_price as number,
        chg: p.unrealized_pct,
      }));
    if (items.length < 6) items = items.concat(SEED.slice(0, 6 - items.length));
  }

  // Duplicate the list so the marquee can loop seamlessly.
  const loop = [...items, ...items];

  return (
    <div className="tape" aria-label="Live tape">
      <div className="tape-track">
        {loop.map((it, i) => (
          <span key={`${it.ticker}-${i}`} className="tape-item">
            <span className="tk">{it.ticker}</span>
            <span className="px">{fmt(it.last)}</span>
            <span className={it.chg >= 0 ? "up" : "down"} style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtPct(it.chg)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
