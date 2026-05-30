const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:7431";

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`${status} ${body || "request failed"}`);
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  if (typeof window !== "undefined") return localStorage.getItem("sc_api_key") || "";
  return process.env.SIGNALCLAW_API_KEY || "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const txt = await r.text();
  if (!r.ok) throw new ApiError(r.status, txt);
  return txt ? (JSON.parse(txt) as T) : (undefined as T);
}

export const swrFetcher = <T,>(path: string) => api<T>(path);

// Types
export type Pick = {
  ticker: string;
  label: string;
  score: number;
  expected_return: number;
  rationale: string;
  risk_flags: string[];
};
export type DailyReport = { as_of: string; picks: Pick[]; disclaimer: string };

export type Regime = {
  label: string;
  as_of: string;
  realized_vol: number;
  trend_slope: number;
  drawdown: number;
  confidence: number;
  risk_scale: number;
};

export type Position = {
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
export type PortfolioSnapshot = {
  positions: Position[];
  total_cost: number;
  total_market_value: number;
  total_unrealized: number;
  total_realized: number;
  weights: Record<string, number>;
};

export type Contribution = {
  ticker: string;
  weight: number;
  period_return: number;
  contribution: number;
};
export type Attribution = {
  benchmark: string;
  window: number;
  portfolio_return: number;
  benchmark_return: number;
  excess_return: number;
  alpha_daily: number;
  alpha_annualized: number;
  beta: number;
  tracking_error_annualized: number;
  information_ratio: number;
  r_squared: number;
  contributions: Contribution[];
};

export type DrawdownState = {
  as_of: string;
  equity: number;
  peak: number;
  peak_date: string;
  drawdown: number;
  tripped: boolean;
  reason: string;
};
export type DrawdownConfig = { trigger: number; rearm: number; min_history_days: number };
export type DrawdownReport = {
  state: DrawdownState;
  config: DrawdownConfig;
  equity_curve: { date: string; equity: number }[];
};

export type Alert = {
  id: string;
  ticker: string;
  condition: string;
  value: number | string;
  note: string;
  cooldown_hours: number;
  enabled: boolean;
  last_fired_at: string | null;
};
export type AlertIn = {
  ticker: string;
  condition: string;
  value: number | string;
  note?: string;
  cooldown_hours?: number;
  enabled?: boolean;
};

export type Bracket = {
  id: string;
  ticker: string;
  side: string;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  status: string;
  note: string;
  created_at: string;
  updated_at: string;
  actual_entry: number | null;
  filled_at: string | null;
  actual_exit: number | null;
  exit_reason: string | null;
  closed_at: string | null;
  risk_per_share: number;
  reward_per_share: number;
  planned_r_multiple: number;
  planned_risk_dollars: number;
  realized_r: number | null;
  realized_pnl: number | null;
};
export type BracketIn = {
  ticker: string;
  side?: string;
  entry: number;
  stop: number;
  target: number;
  shares: number;
  note?: string;
};
export type BracketStats = {
  total: number;
  open: number;
  filled: number;
  closed: number;
  cancelled: number;
  win_rate: number;
  avg_r: number;
  median_r: number;
  expectancy: number;
};

export type JournalEntry = {
  trade_id: string;
  thesis: string;
  conviction: number;
  tags: string[];
  exit_reason: string | null;
  created_at: string;
  updated_at: string;
};
export type JournalEntryIn = {
  trade_id: string;
  thesis?: string;
  conviction?: number;
  tags?: string[];
  exit_reason?: string | null;
};

export type FxRate = { currency: string; date: string; rate: number };

export type ReportSummary = {
  as_of: string;
  n_picks: number;
  n_watch: number;
  n_hold: number;
  n_skip: number;
  top_pick: string | null;
};
export type ReportHistory = { summaries: ReportSummary[] };
export type ReportDiff = {
  prior_as_of: string | null;
  current_as_of: string;
  new_picks: string[];
  dropped_picks: string[];
  upgraded: { ticker: string; from: string; to: string }[];
  downgraded: { ticker: string; from: string; to: string }[];
  score_changes: { ticker: string; delta: number; from?: number; to?: number }[];
  unchanged: string[];
};

export type CorrelationMatrix = {
  tickers: string[];
  matrix: number[][];
  window: number;
};
export type Diversification = {
  window: number;
  threshold: number;
  n_tickers: number;
  avg_pairwise_corr: number;
  max_pairwise_corr: number;
  most_correlated_pair: string[] | null;
  clusters: string[][];
  warnings: string[];
};

export type SectorScore = {
  sector: string;
  n_tickers: number;
  ret_1m: number;
  ret_3m: number;
  ret_6m: number;
  rs_slope: number;
  breadth: number;
  composite: number;
  call: string;
  members: string[];
};
export type RotationReport = {
  benchmark: string;
  asof: string;
  overweight: string[];
  underweight: string[];
  scores: SectorScore[];
  skipped_unknown_sector: string[];
  skipped_short_history: string[];
};

export type SectorExposure = {
  sector: string;
  market_value: number;
  weight: number;
  tickers: string[];
};
export type Concentration = {
  total_market_value: number;
  sectors: SectorExposure[];
  hhi: number;
  effective_n_sectors: number;
  max_sector: string | null;
  max_sector_weight: number;
  max_position: string | null;
  max_position_weight: number;
  sector_cap: number;
  position_cap: number;
  breaches: string[];
  warnings: string[];
  unknown_tickers: string[];
};

export type Earnings = {
  ticker: string;
  next_report: string;
  confirmed: boolean;
  source: string;
};
export type EarningsIn = {
  next_report: string;
  confirmed?: boolean;
  source?: string;
};
export type EarningsList = { rows: Earnings[] };

export type NewsEvent = {
  id: string;
  ticker: string;
  headline: string;
  event_date: string;
  tags: string[];
  source: string;
  url: string;
  created_at: string;
};
export type NewsEventIn = {
  ticker: string;
  headline: string;
  event_date: string;
  tags?: string[];
  source?: string;
  url?: string;
};
export type NewsEventList = { events: NewsEvent[] };
export type EventStats = {
  n: number;
  hit_rate: number;
  mean: number;
  median: number;
  stdev: number;
  min: number;
  max: number;
};
export type EventStudy = {
  n_events: number;
  horizons: number[];
  overall: Record<string, EventStats>;
  by_tag: Record<string, Record<string, EventStats>>;
  by_ticker: Record<string, Record<string, EventStats>>;
};

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  tickers: string[];
  secret: string;
  enabled: boolean;
  created_at: string;
  last_status: number | null;
  last_error: string | null;
  last_delivered_at: string | null;
};
export type WebhookIn = {
  url: string;
  events?: string[];
  tickers?: string[];
  secret?: string;
  enabled?: boolean;
};
export type WebhookList = { subscriptions: Webhook[] };
export type WebhookDelivery = {
  events: {
    kind: string;
    ticker: string;
    as_of: string;
    new_label?: string | null;
    prior_label?: string | null;
    score_delta?: number | null;
  }[];
  deliveries: Record<string, unknown>[];
};

// Stops
export type StopRule = {
  id: string;
  ticker: string;
  kind: string; // stop_loss | take_profit | trailing
  value: number;
  high_water?: number | null;
  armed_at: string;
  note: string;
};
export type StopRuleIn = {
  ticker: string;
  kind: string;
  value: number;
  note?: string;
};
export type StopEvent = {
  rule_id: string;
  ticker: string;
  kind: string;
  trigger_price: number;
  reference_price: number;
  timestamp: string;
};
export type StopCheck = { checked: number; events: StopEvent[] };

// Correlation / Diversification types are declared above.

// Ledger / Margin
export type LedgerEntry = {
  ts: string;
  kind: string;
  amount: number;
  ticker?: string | null;
  shares: number;
  price: number;
  note: string;
};
export type LedgerList = { account: string; entries: LedgerEntry[] };
export type AccountSnapshot = {
  account: string;
  cash: number;
  long_market_value: number;
  short_market_value: number;
  equity: number;
  margin_used: number;
  initial_requirement: number;
  maintenance_requirement: number;
  buying_power: number;
  excess_liquidity: number;
  margin_call: boolean;
  margin_call_amount: number;
};
export type MarginConfig = {
  initial_margin: number;
  maintenance_margin: number;
  annual_interest_rate: number;
};

// Notifier DLQ
export type DeadLetter = {
  id: string;
  channel: string;
  text: string;
  attempts: number;
  last_error: string;
  enqueued_at: string;
};
export type DeadLetterList = { items: DeadLetter[] };
export type DlqReplay = { sent: number; kept: number; skipped: number };

// Back-compat aliases
export type Report = DailyReport;
export type Backtest = {
  ticker: string;
  sharpe: number;
  sortino: number;
  max_drawdown: number;
  hit_rate: number;
  cagr: number;
  n_trades: number;
  equity_curve: number[];
  dates: string[];
};
