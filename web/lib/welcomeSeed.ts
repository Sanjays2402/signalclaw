// Sample payload generator for the onboarding flow.
// Deterministic so the seeded run is identical run to run.

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export type SamplePayload = {
  ticker: string;
  dates: string[];
  close: number[];
  regime: string[];
  counts: Record<string, number>;
  snapshot: {
    label: string;
    realized_vol: number;
    trend_slope: number;
    drawdown: number;
    confidence: number;
    risk_scale: number;
    as_of: string;
  };
  disclaimer: string;
};

export function buildSamplePayload(ticker: string, bars: number): SamplePayload {
  const rand = lcg(0xc1a05af);
  const dates: string[] = [];
  const close: number[] = [];
  const regime: string[] = [];
  const counts: Record<string, number> = { bull: 0, chop: 0, bear: 0, crash: 0 };

  const start = new Date(Date.UTC(2024, 0, 2));
  let price = 100;
  const segments: Array<{ label: "bull" | "chop" | "bear" | "crash"; drift: number; vol: number }> = [
    { label: "bull", drift: 0.0009, vol: 0.008 },
    { label: "chop", drift: 0.0, vol: 0.011 },
    { label: "bear", drift: -0.0011, vol: 0.014 },
    { label: "bull", drift: 0.0012, vol: 0.009 },
  ];
  const perSeg = Math.floor(bars / segments.length);

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const n = s === segments.length - 1 ? bars - perSeg * (segments.length - 1) : perSeg;
    for (let i = 0; i < n; i++) {
      const idx = dates.length;
      const day = new Date(start.getTime() + idx * 24 * 3600 * 1000);
      dates.push(day.toISOString().slice(0, 10));
      const shock = (rand() - 0.5) * 2 * seg.vol;
      price = Math.max(1, price * (1 + seg.drift + shock));
      close.push(Number(price.toFixed(4)));
      regime.push(seg.label);
      counts[seg.label] += 1;
    }
  }

  const last = close[close.length - 1];
  const window = close.slice(-20);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance =
    window.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, window.length - 1);
  const realized_vol = Math.sqrt(variance) / mean;
  const trend_slope = (last - close[close.length - 20]) / close[close.length - 20];
  const peak = Math.max(...close);
  const drawdown = (last - peak) / peak;

  return {
    ticker,
    dates,
    close,
    regime,
    counts,
    snapshot: {
      label: regime[regime.length - 1],
      realized_vol: Number(realized_vol.toFixed(6)),
      trend_slope: Number(trend_slope.toFixed(6)),
      drawdown: Number(drawdown.toFixed(6)),
      confidence: 0.78,
      risk_scale: 1,
      as_of: dates[dates.length - 1],
    },
    disclaimer:
      "Sample regime classification seeded by the welcome flow. Not investment advice.",
  };
}

export function normalizeSeedTicker(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  return (raw || "ACME").toUpperCase().slice(0, 8);
}
