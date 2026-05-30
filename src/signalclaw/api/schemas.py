from __future__ import annotations
from typing import List, Optional, Union
from pydantic import BaseModel


class Pick(BaseModel):
    ticker: str
    label: str
    score: float
    expected_return: float
    rationale: str
    risk_flags: List[str] = []


class DailyReportOut(BaseModel):
    as_of: str
    picks: List[Pick]
    disclaimer: str = "NOT FINANCIAL ADVICE. See FINANCIAL_DISCLAIMER.md."


class WatchlistOut(BaseModel):
    tickers: List[str]


class WatchlistIn(BaseModel):
    ticker: str


class BacktestOut(BaseModel):
    ticker: str
    sharpe: float
    sortino: float
    max_drawdown: float
    hit_rate: float
    cagr: float
    n_trades: int
    equity_curve: List[float]
    dates: List[str]


class AlertIn(BaseModel):
    ticker: str
    condition: str
    value: Union[float, str]
    note: str = ""
    cooldown_hours: int = 12
    enabled: bool = True


class AlertOut(BaseModel):
    id: str
    ticker: str
    condition: str
    value: Union[float, str]
    note: str = ""
    cooldown_hours: int = 12
    enabled: bool = True
    last_fired_at: Optional[str] = None


class AlertListOut(BaseModel):
    alerts: List[AlertOut]


class AlertHitOut(BaseModel):
    alert_id: str
    ticker: str
    condition: str
    value: Union[float, str]
    observed: Union[float, str]
    fired_at: str
    note: str = ""


class AlertCheckOut(BaseModel):
    checked: int
    hits: List[AlertHitOut]


class TradeIn(BaseModel):
    ticker: str
    side: str
    quantity: float
    price: float
    date: str
    fees: float = 0.0
    note: str = ""


class TradeOut(BaseModel):
    id: str
    ticker: str
    side: str
    quantity: float
    price: float
    date: str
    fees: float = 0.0
    note: str = ""
    realized_pnl: float = 0.0


class TradeListOut(BaseModel):
    trades: List[TradeOut]


class PositionPnLOut(BaseModel):
    ticker: str
    quantity: float
    avg_cost: float
    last_price: Optional[float] = None
    market_value: float
    cost: float
    unrealized_pnl: float
    unrealized_pct: float
    realized_pnl: float


class PortfolioSnapshotOut(BaseModel):
    positions: List[PositionPnLOut]
    total_cost: float
    total_market_value: float
    total_unrealized: float
    total_realized: float
    weights: dict


class SizingOut(BaseModel):
    ticker: str
    price: float
    atr: float
    stop_loss: float
    take_profit: float
    risk_per_share: float
    shares: int
    dollar_size: float
    weight: float
    risk_amount: float
    kelly_suggested: float
    kelly_capped: float
    cap_reason: str


class SizingRequest(BaseModel):
    ticker: str
    label: str
    score: float
    equity: float = 100_000.0
    risk_per_trade: float = 0.01
    max_position_pct: float = 0.20
    kelly_fraction: float = 0.25
    kelly_cap: float = 0.10
    atr_stop_mult: float = 2.0
    atr_target_mult: float = 3.0


class CorrelationMatrixOut(BaseModel):
    tickers: List[str]
    matrix: List[List[float]]
    window: int


class DiversificationOut(BaseModel):
    window: int
    threshold: float
    n_tickers: int
    avg_pairwise_corr: float
    max_pairwise_corr: float
    most_correlated_pair: Optional[List[str]] = None
    clusters: List[List[str]]
    warnings: List[str]


class ReportSummaryOut(BaseModel):
    as_of: str
    n_picks: int
    n_watch: int
    n_hold: int
    n_skip: int
    top_pick: Optional[str] = None


class ReportHistoryOut(BaseModel):
    summaries: List[ReportSummaryOut]


class ReportDiffOut(BaseModel):
    prior_as_of: Optional[str] = None
    current_as_of: str
    new_picks: List[str] = []
    dropped_picks: List[str] = []
    upgraded: List[dict] = []
    downgraded: List[dict] = []
    score_changes: List[dict] = []
    unchanged: List[str] = []


class StopRuleIn(BaseModel):
    ticker: str
    kind: str  # stop_loss | take_profit | trailing
    value: float
    note: str = ""


class StopRuleOut(BaseModel):
    id: str
    ticker: str
    kind: str
    value: float
    high_water: Optional[float] = None
    armed_at: str
    note: str = ""


class StopRuleListOut(BaseModel):
    rules: List[StopRuleOut]


class StopEventOut(BaseModel):
    rule_id: str
    ticker: str
    kind: str
    trigger_price: float
    reference_price: float
    timestamp: str


class StopCheckOut(BaseModel):
    checked: int
    events: List[StopEventOut]


class TickerContributionOut(BaseModel):
    ticker: str
    weight: float
    period_return: float
    contribution: float


class AttributionOut(BaseModel):
    benchmark: str
    window: int
    portfolio_return: float
    benchmark_return: float
    excess_return: float
    alpha_daily: float
    alpha_annualized: float
    beta: float
    tracking_error_annualized: float
    information_ratio: float
    r_squared: float
    contributions: List[TickerContributionOut]


class SectorExposureOut(BaseModel):
    sector: str
    market_value: float
    weight: float
    tickers: List[str]


class ConcentrationOut(BaseModel):
    total_market_value: float
    sectors: List[SectorExposureOut]
    hhi: float
    effective_n_sectors: float
    max_sector: Optional[str] = None
    max_sector_weight: float
    max_position: Optional[str] = None
    max_position_weight: float
    sector_cap: float
    position_cap: float
    breaches: List[str] = []
    warnings: List[str] = []
    unknown_tickers: List[str] = []


class RealizedEventOut(BaseModel):
    ticker: str
    sell_trade_id: str
    sell_date: str
    quantity: float
    proceeds: float
    cost_basis: float
    realized_pnl: float
    lot_acquired: Optional[str] = None
    holding_days: Optional[int] = None
    long_term: Optional[bool] = None


class WashSaleFlagOut(BaseModel):
    ticker: str
    sell_trade_id: str
    sell_date: str
    loss: float
    triggering_buy_id: str
    triggering_buy_date: str
    days_between: int


class TaxReportOut(BaseModel):
    method: str
    realized_total: float
    realized_short_term: float
    realized_long_term: float
    events: List[RealizedEventOut]
    wash_sales: List[WashSaleFlagOut]


class OptFoldOut(BaseModel):
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    chosen: List[float]
    train_sharpe: float
    test_sharpe: float
    test_return: float
    test_hit_rate: float
    test_max_drawdown: float


class OptResultOut(BaseModel):
    ticker: str
    folds: List[OptFoldOut]
    most_common_params: Optional[List[float]] = None
    most_common_share: float
    median_test_sharpe: float
    mean_test_sharpe: float
    mean_test_return: float
    n_folds: int
    grid_size: int


class WebhookIn(BaseModel):
    url: str
    events: List[str] = []
    tickers: List[str] = []
    secret: str = ""
    enabled: bool = True


class WebhookOut(BaseModel):
    id: str
    url: str
    events: List[str]
    tickers: List[str]
    secret: str = ""
    enabled: bool
    created_at: str
    last_status: Optional[int] = None
    last_error: Optional[str] = None
    last_delivered_at: Optional[str] = None


class WebhookListOut(BaseModel):
    subscriptions: List[WebhookOut]


class PickEventOut(BaseModel):
    kind: str
    ticker: str
    as_of: str
    prior_as_of: Optional[str] = None
    prior_label: Optional[str] = None
    new_label: Optional[str] = None
    prior_score: Optional[float] = None
    new_score: Optional[float] = None
    score_delta: Optional[float] = None


class WebhookDeliveryOut(BaseModel):
    events: List[PickEventOut]
    deliveries: List[dict]


class EarningsIn(BaseModel):
    next_report: str
    confirmed: bool = False
    source: str = "manual"


class EarningsOut(BaseModel):
    ticker: str
    next_report: str
    confirmed: bool = False
    source: str = "manual"


class EarningsListOut(BaseModel):
    rows: List[EarningsOut]



class DrawdownConfigOut(BaseModel):
    trigger: float
    rearm: float
    min_history_days: int


class DrawdownStateOut(BaseModel):
    as_of: str
    equity: float
    peak: float
    peak_date: str
    drawdown: float
    tripped: bool
    reason: str


class DrawdownReportOut(BaseModel):
    state: DrawdownStateOut
    config: DrawdownConfigOut
    equity_curve: List[dict]


class DrawdownConfigIn(BaseModel):
    trigger: Optional[float] = None
    rearm: Optional[float] = None
    min_history_days: Optional[int] = None
    cash: Optional[float] = None


class JournalEntryIn(BaseModel):
    trade_id: str
    thesis: str = ""
    conviction: int = 3
    tags: List[str] = []
    exit_reason: Optional[str] = None


class JournalEntryOut(BaseModel):
    trade_id: str
    thesis: str
    conviction: int
    tags: List[str]
    exit_reason: Optional[str] = None
    created_at: str
    updated_at: str


class JournalListOut(BaseModel):
    entries: List[JournalEntryOut]


class ConvictionBucketOut(BaseModel):
    conviction: int
    n_trades: int
    realized_pnl: float
    avg_realized_pnl: float
    win_rate: float


class ConvictionStatsOut(BaseModel):
    buckets: List[ConvictionBucketOut]


class FxRateOut(BaseModel):
    currency: str
    date: str
    rate: float


class FxListOut(BaseModel):
    currencies: List[str]


class FxRateIn(BaseModel):
    currency: str
    date: str
    rate: float


class TradeCurrencyIn(BaseModel):
    trade_id: str
    currency: str


class TradeCurrencyOut(BaseModel):
    map: dict


class ConversionAuditOut(BaseModel):
    trade_id: str
    native_currency: str
    native_amount: float
    rate: Optional[float] = None
    base_amount: Optional[float] = None
    rate_date: Optional[str] = None
    fallback: bool


class ConvertedTradesOut(BaseModel):
    base: str
    audits: List[ConversionAuditOut]
    total_base_cost: float
    total_fallback_native: float


class DeadLetterOut(BaseModel):
    id: str
    channel: str
    text: str
    attempts: int
    last_error: str
    enqueued_at: str


class DeadLetterListOut(BaseModel):
    items: List[DeadLetterOut]


class DlqReplayOut(BaseModel):
    sent: int
    kept: int
    skipped: int


class NotifyTestIn(BaseModel):
    channel: str  # slack | telegram | discord
    text: str = "SignalClaw test"


class BracketPlanIn(BaseModel):
    ticker: str
    side: str = "long"
    entry: float
    stop: float
    target: float
    shares: int
    note: str = ""


class BracketFillIn(BaseModel):
    actual_entry: float


class BracketCloseIn(BaseModel):
    actual_exit: float
    reason: str


class BracketPlanOut(BaseModel):
    id: str
    ticker: str
    side: str
    entry: float
    stop: float
    target: float
    shares: int
    status: str
    note: str
    created_at: str
    updated_at: str
    actual_entry: Optional[float] = None
    filled_at: Optional[str] = None
    actual_exit: Optional[float] = None
    exit_reason: Optional[str] = None
    closed_at: Optional[str] = None
    risk_per_share: float
    reward_per_share: float
    planned_r_multiple: float
    planned_risk_dollars: float
    realized_r: Optional[float] = None
    realized_pnl: Optional[float] = None


class BracketListOut(BaseModel):
    plans: List[BracketPlanOut]


class BracketStatsOut(BaseModel):
    total: int
    open: int
    filled: int
    closed: int
    cancelled: int
    win_rate: float
    avg_r: float
    median_r: float
    expectancy: float
    avg_win_r: float
    avg_loss_r: float
    total_realized_pnl: float
    by_exit_reason: dict


class SectorScoreOut(BaseModel):
    sector: str
    n_tickers: int
    ret_1m: float
    ret_3m: float
    ret_6m: float
    rs_slope: float
    breadth: float
    composite: float
    call: str
    members: List[str]


class RotationOut(BaseModel):
    benchmark: str
    asof: str
    overweight: List[str]
    underweight: List[str]
    scores: List[SectorScoreOut]
    skipped_unknown_sector: List[str]
    skipped_short_history: List[str]


class NewsEventIn(BaseModel):
    ticker: str
    headline: str
    event_date: str
    tags: List[str] = []
    source: str = ""
    url: str = ""


class NewsEventOut(BaseModel):
    id: str
    ticker: str
    headline: str
    event_date: str
    tags: List[str]
    source: str
    url: str
    created_at: str


class NewsEventListOut(BaseModel):
    events: List[NewsEventOut]


class EventStatsOut(BaseModel):
    n: int
    hit_rate: float
    mean: float
    median: float
    stdev: float
    min: float
    max: float


class EventStudyOut(BaseModel):
    n_events: int
    horizons: List[int]
    overall: dict
    by_tag: dict
    by_ticker: dict


class CostModelIn(BaseModel):
    commission_per_trade: float = 0.0
    commission_per_share: float = 0.0
    slippage_bps: float = 0.0
    min_commission: float = 0.0


class PretradeIn(BaseModel):
    ticker: str
    side: str = "long"
    price: float
    stop: float
    target: float
    equity: float
    risk_per_trade: float = 0.01
    max_position_pct: float = 0.20
    max_portfolio_pct: float = 1.0
    min_shares: int = 1
    existing_shares: int = 0
    existing_avg_price: float = 0.0
    cost: Optional[CostModelIn] = None


class PretradeOut(BaseModel):
    ticker: str
    side: str
    shares: int
    notional: float
    fees: float
    total_cost: float
    risk_per_share: float
    reward_per_share: float
    planned_r_multiple: float
    planned_risk_dollars: float
    planned_reward_dollars: float
    weight: float
    post_trade_ticker_pct: float
    cap_reason: str
    accepted: bool
    warnings: List[str]
