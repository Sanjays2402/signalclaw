// Empty default = same-origin (Next API routes via rewrites in next.config.ts).
// Set NEXT_PUBLIC_API_URL to point at an external FastAPI backend.
const BASE = process.env.NEXT_PUBLIC_API_URL || "";

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

function mfaCode(): string {
  // Short-lived per-tab MFA code. The Security page writes it here just
  // before an admin action; we send it on every request because admin
  // routes are infrequent and the server rejects replays anyway.
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("sc_mfa_code") || "";
}

function takeRecoveryCode(): string {
  // Single-use recovery code escape hatch. The Security page writes it
  // here right before the next admin call; we consume and clear it so
  // the same code is never sent twice (the server also enforces this).
  if (typeof window === "undefined") return "";
  const v = sessionStorage.getItem("sc_mfa_recovery_code") || "";
  if (v) sessionStorage.removeItem("sc_mfa_recovery_code");
  return v;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const code = mfaCode();
  const recovery = takeRecoveryCode();
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      ...(code ? { "x-mfa-code": code } : {}),
      ...(recovery ? { "x-mfa-recovery-code": recovery } : {}),
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

export type RegimeSeries = {
  ticker: string;
  dates: string[];
  close: number[];
  regime: (string | null)[];
  counts: Record<string, number>;
  snapshot: Regime | null;
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

export type AlertEvent = {
  alert_id: string;
  ticker: string;
  condition: string;
  value: number | string;
  observed: number | string;
  fired_at: string;
  note: string;
};
export type AlertHistory = {
  total: number;
  limit: number;
  offset: number;
  events: AlertEvent[];
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
export type FxList = { currencies: string[] };

// Scaling plans
export type ScaleRung = {
  r_multiple: number;
  action: string; // add | trim
  size_fraction: number;
  new_stop_r?: number | null;
};
export type ScalingPlan = {
  plan_id: string;
  ticker: string;
  entry: number;
  initial_stop: number;
  initial_shares: number;
  status: string;
  triggered: number[];
  rungs: ScaleRung[];
};
export type ScalingPlanList = { plans: ScalingPlan[] };
export type ScalingPlanIn = {
  ticker: string;
  entry: number;
  initial_stop: number;
  initial_shares: number;
  rungs: ScaleRung[];
};
export type ScaleBar = { index: number; high: number; low: number };
export type ScaleEvent = {
  plan_id: string;
  ticker: string;
  rung_index: number;
  action: string;
  trigger_price: number;
  bar_index: number;
  shares: number;
  new_stop?: number | null;
  r_multiple: number;
};
export type ScaleEvaluate = { plan: ScalingPlan; events: ScaleEvent[] };

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
  previous_secret?: string;
  previous_secret_expires_at?: string | null;
  secret_rotated_at?: string | null;
  owner_key_id: string | null;
};
export type WebhookIn = {
  url: string;
  events?: string[];
  tickers?: string[];
  secret?: string;
  enabled?: boolean;
};
export type WebhookRotateSecretIn = {
  secret?: string;
  grace_seconds?: number;
};
export type WebhookRotateSecretOut = {
  id: string;
  secret_rotated_at: string | null;
  previous_secret_expires_at: string | null;
  grace_seconds: number;
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
export type WebhookDeliveryLogItem = {
  id: string;
  subscription_id: string;
  url: string;
  status: number | null;
  error: string | null;
  attempt: number;
  delivered_at: string;
  signature: string | null;
  event_count: number;
  events?: {
    kind: string;
    ticker: string;
    as_of: string;
    new_label?: string | null;
    prior_label?: string | null;
    score_delta?: number | null;
  }[];
  replay_of?: string | null;
};
export type WebhookDeliveryLog = { deliveries: WebhookDeliveryLogItem[] };

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

export type TaxEvent = {
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

export type WashSale = {
  ticker: string;
  sell_trade_id: string;
  sell_date: string;
  loss: number;
  triggering_buy_id: string;
  triggering_buy_date: string;
  days_between: number;
};

export type TaxReport = {
  method: string;
  events: TaxEvent[];
  realized_total: number;
  realized_short_term: number;
  realized_long_term: number;
  wash_sales: WashSale[];
};

export type OptFold = {
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  chosen: number[];
  train_sharpe: number;
  test_sharpe: number;
  test_return: number;
  test_hit_rate: number;
  test_max_drawdown: number;
};

export type OptResult = {
  ticker: string;
  folds: OptFold[];
  most_common_params: number[] | null;
  most_common_share: number;
  median_test_sharpe: number;
  mean_test_sharpe: number;
  mean_test_return: number;
  n_folds: number;
  grid_size: number;
};

export type ExecBar = { index: number; price: number; volume: number };
export type ExecOrder = {
  ticker: string;
  side: string;
  shares: number;
  arrival_price: number;
  schedule: string;
  expected_curve?: number[] | null;
  participation_rate?: number;
  max_participation?: number;
  base_slippage_bps?: number;
  slippage_bps_per_pct_adv?: number;
  commission_per_share?: number;
};
export type ExecFill = {
  bar_index: number;
  shares: number;
  fill_price: number;
  market_price: number;
  participation: number;
  slippage_bps: number;
  commission: number;
};
export type ExecReport = {
  ticker: string;
  side: string;
  requested_shares: number;
  filled_shares: number;
  unfilled_shares: number;
  arrival_price: number;
  avg_fill_price: number;
  interval_vwap: number;
  notional: number;
  commission_total: number;
  slippage_vs_arrival_bps: number;
  slippage_vs_vwap_bps: number;
  fills: ExecFill[];
};

// Back-compat aliases
export type Report = DailyReport;
export type BacktestTrade = {
  entry_date: string;
  exit_date: string;
  bars: number;
  return_pct: number;
};
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
  buy_hold_curve?: number[] | null;
  drawdown_curve?: number[] | null;
  position?: number[] | null;
  trades?: BacktestTrade[] | null;
  benchmark_cagr?: number | null;
  benchmark_max_drawdown?: number | null;
  exposure?: number | null;
};

export type FeatureContrib = {
  name: string;
  label: string;
  value: number;
  direction: "bullish" | "bearish" | "neutral";
  weight: number;
  note: string;
};

export type Explain = {
  ticker: string;
  as_of: string;
  label: "watch" | "hold" | "skip";
  score: number;
  expected_return: number;
  proba: { skip: number; hold: number; watch: number };
  rationale: string;
  risk_flags: string[];
  features: FeatureContrib[];
  dates: string[];
  close: number[];
  history_label?: string | null;
  disclaimer: string;
};
