from __future__ import annotations
from typing import List
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
