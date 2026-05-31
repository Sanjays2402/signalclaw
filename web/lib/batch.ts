// Pure helpers for the batch regime classifier.
// Kept framework-free so they can be unit-tested with node:test.

export type BatchRow = {
  ticker: string;
  ok: boolean;
  status: number;
  regime: string | null;
  confidence: number | null;
  risk_scale: number | null;
  as_of: string | null;
  run_id: string | null;
  error: string | null;
};

// Parse a free-form tickers blob from a textarea or uploaded CSV/text file.
// Splits on commas, whitespace, semicolons, and newlines. Strips an optional
// CSV header row when the first cell is literally "ticker" or "symbol".
// Dedupes, uppercases, drops obvious junk, and caps the list.
export function parseTickers(input: string, maxCount = 50): string[] {
  if (!input) return [];
  const raw = input.replace(/\r/g, "").split(/[\s,;]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i].trim();
    if (!t) continue;
    // Drop a CSV header on the first token.
    if (i === 0 && /^(ticker|symbol)$/i.test(t)) continue;
    // Strip surrounding quotes from naive CSV.
    t = t.replace(/^["']+|["']+$/g, "");
    if (!t) continue;
    // Allow letters, digits, dot, dash. Keep it tight.
    if (!/^[A-Za-z0-9.\-]{1,16}$/.test(t)) continue;
    const up = t.toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    out.push(up);
    if (out.length >= maxCount) break;
  }
  return out;
}

export function rowsToCSV(rows: BatchRow[]): string {
  const header = [
    "ticker",
    "ok",
    "status",
    "regime",
    "confidence",
    "risk_scale",
    "as_of",
    "run_id",
    "error",
  ];
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.ticker,
        r.ok ? "true" : "false",
        r.status,
        r.regime,
        r.confidence,
        r.risk_scale,
        r.as_of,
        r.run_id,
        r.error,
      ]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// Run an async worker over items with bounded concurrency.
// Resolves in input order. Errors are caught by the caller's worker.
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out: R[] = new Array(n);
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, n));
  async function runOne(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= n) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => runOne()));
  return out;
}
