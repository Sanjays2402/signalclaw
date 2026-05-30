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

