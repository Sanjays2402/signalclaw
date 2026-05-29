const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = typeof window !== "undefined"
    ? (localStorage.getItem("sc_api_key") || "")
    : (process.env.SIGNALCLAW_API_KEY || "");
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": key, ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

export type Pick = { ticker: string; label: string; score: number; expected_return: number; rationale: string; risk_flags: string[]; };
export type Report = { as_of: string; picks: Pick[]; disclaimer: string; };
export type Backtest = { ticker: string; sharpe: number; sortino: number; max_drawdown: number; hit_rate: number; cagr: number; n_trades: number; equity_curve: number[]; dates: string[]; };
