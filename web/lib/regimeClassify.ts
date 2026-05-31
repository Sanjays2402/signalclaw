// Real regime classifier: takes a close-price series and produces the same
// SavedRun payload shape the demo/UI uses. Pure function, no I/O. Used by
// POST /v1/runs so API consumers can submit their own series and get a real
// classification back.
//
// Algorithm (deterministic, no external data):
//   1. For each bar i, compute a rolling 20-bar slope (log-return per bar)
//      and a rolling 20-bar realized volatility (stdev of log returns).
//   2. Label each bar:
//        crash : drawdown from rolling 60-bar peak < -0.20 AND vol > 0.025
//        bear  : slope < -0.0005
//        bull  : slope >  0.0005
//        chop  : otherwise
//   3. Snapshot is the last bar's metrics + a confidence derived from how
//      cleanly the trailing window agrees on a single label.

const WINDOW = 20;
const PEAK_WINDOW = 60;

export type ClassifyPayload = {
  ticker: string;
  dates: string[];
  close: number[];
  regime: (string | null)[];
  counts: Record<string, number>;
  snapshot: {
    label: string;
    realized_vol: number;
    trend_slope: number;
    drawdown: number;
    confidence: number;
    risk_scale: number;
    as_of: string;
  } | null;
  disclaimer: string;
};

function isFinitePos(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

function syntheticDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  // Walk backwards N business-day-ish steps from today, then reverse.
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const ms = 24 * 3600 * 1000;
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(start.getTime() - i * ms).toISOString().slice(0, 10));
  }
  return out;
}

function labelFor(slope: number, vol: number, drawdown: number): string {
  if (drawdown < -0.2 && vol > 0.025) return "crash";
  if (slope < -0.0005) return "bear";
  if (slope > 0.0005) return "bull";
  return "chop";
}

export type ClassifyInput = {
  ticker: string;
  close: number[];
  dates?: string[];
  lookback_days?: number;
};

export type ClassifyError = { code: string; message: string };

export function classifyRegime(
  input: ClassifyInput,
): { ok: true; payload: ClassifyPayload } | { ok: false; error: ClassifyError } {
  const ticker = (input.ticker || "").trim().toUpperCase();
  if (!ticker || ticker.length > 32) {
    return { ok: false, error: { code: "bad_ticker", message: "ticker must be 1..32 chars" } };
  }
  const close = Array.isArray(input.close) ? input.close.slice() : [];
  if (close.length < WINDOW + 1) {
    return {
      ok: false,
      error: {
        code: "series_too_short",
        message: `close must contain at least ${WINDOW + 1} positive numbers`,
      },
    };
  }
  if (close.length > 5000) {
    return { ok: false, error: { code: "series_too_long", message: "close exceeds 5000 entries" } };
  }
  for (const v of close) {
    if (!isFinitePos(v)) {
      return {
        ok: false,
        error: { code: "bad_close", message: "close values must be finite positive numbers" },
      };
    }
  }

  let dates: string[];
  if (Array.isArray(input.dates) && input.dates.length === close.length) {
    for (const d of input.dates) {
      if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return {
          ok: false,
          error: { code: "bad_dates", message: "dates must be YYYY-MM-DD and match close length" },
        };
      }
    }
    dates = input.dates.slice();
  } else if (input.dates !== undefined) {
    return {
      ok: false,
      error: { code: "bad_dates", message: "dates length must equal close length" },
    };
  } else {
    dates = syntheticDates(close.length);
  }

  // Log returns.
  const ret: number[] = [0];
  for (let i = 1; i < close.length; i++) {
    ret.push(Math.log(close[i] / close[i - 1]));
  }

  const regime: (string | null)[] = new Array(close.length).fill(null);
  const counts: Record<string, number> = { bull: 0, chop: 0, bear: 0, crash: 0 };

  let lastSlope = 0;
  let lastVol = 0;
  let lastDD = 0;

  for (let i = 0; i < close.length; i++) {
    if (i < WINDOW) {
      regime[i] = null;
      continue;
    }
    const w = ret.slice(i - WINDOW + 1, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, w.length - 1);
    const vol = Math.sqrt(variance);
    const slope = mean;
    const peakStart = Math.max(0, i - PEAK_WINDOW + 1);
    const peak = Math.max(...close.slice(peakStart, i + 1));
    const dd = (close[i] - peak) / peak;
    const lab = labelFor(slope, vol, dd);
    regime[i] = lab;
    counts[lab] = (counts[lab] ?? 0) + 1;
    lastSlope = slope;
    lastVol = vol;
    lastDD = dd;
  }

  // Confidence: fraction of last 20 labeled bars that agree with the most
  // recent label. Clipped to [0.4, 0.98] so it never reads as fake-certain.
  const lastLabel = regime[regime.length - 1] ?? "chop";
  const tail = regime.slice(-WINDOW).filter((x): x is string => x !== null);
  const agree = tail.filter((x) => x === lastLabel).length;
  const rawConf = tail.length === 0 ? 0.5 : agree / tail.length;
  const confidence = Math.max(0.4, Math.min(0.98, rawConf));

  // Risk scale: shrink exposure as vol climbs. Vol of 1%/bar => 1.0; 3%/bar => ~0.33.
  const risk_scale = Math.max(0.1, Math.min(1, 0.01 / Math.max(0.003, lastVol)));

  const payload: ClassifyPayload = {
    ticker,
    dates,
    close,
    regime,
    counts,
    snapshot: {
      label: lastLabel,
      realized_vol: Number(lastVol.toFixed(6)),
      trend_slope: Number(lastSlope.toFixed(6)),
      drawdown: Number(lastDD.toFixed(6)),
      confidence: Number(confidence.toFixed(4)),
      risk_scale: Number(risk_scale.toFixed(4)),
      as_of: dates[dates.length - 1],
    },
    disclaimer:
      "Regime classification computed from caller-supplied price series. Not investment advice.",
  };

  return { ok: true, payload };
}
