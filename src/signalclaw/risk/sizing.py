"""Position sizing and risk targets.

Provides:
  - kelly_fraction(p, b): textbook Kelly for binary outcome
  - capped_kelly_fraction: fractional + hard cap
  - atr_stops: ATR-based stop-loss and target distances
  - position_size: shares + dollar size from equity, price, stop, risk_per_trade
  - size_pick: end-to-end helper from price/ATR/signal score to a SizingResult
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Optional

import pandas as pd

from ..features import atr as _atr_indicator


@dataclass
class RiskConfig:
    """Risk policy. All values are dimensionless ratios except equity (dollars)."""
    equity: float = 100_000.0
    risk_per_trade: float = 0.01      # fraction of equity risked at stop
    max_position_pct: float = 0.20    # max single-name weight
    kelly_fraction: float = 0.25      # fractional Kelly (0..1)
    kelly_cap: float = 0.10           # hard cap on Kelly result
    atr_stop_mult: float = 2.0        # stop distance = atr_stop_mult * ATR
    atr_target_mult: float = 3.0      # target distance = atr_target_mult * ATR
    min_shares: int = 1


@dataclass
class SizingResult:
    ticker: str
    price: float
    atr: float
    stop_loss: float
    take_profit: float
    risk_per_share: float
    shares: int
    dollar_size: float
    weight: float                 # dollar_size / equity
    risk_amount: float            # shares * risk_per_share
    kelly_suggested: float
    kelly_capped: float
    cap_reason: str               # which constraint was binding

    def to_dict(self) -> dict:
        return asdict(self)


def kelly_fraction(win_prob: float, win_loss_ratio: float) -> float:
    """Classic Kelly: f* = p - (1-p)/b. Returns 0 if not edge or bad inputs."""
    if win_loss_ratio <= 0 or not (0.0 <= win_prob <= 1.0):
        return 0.0
    f = win_prob - (1.0 - win_prob) / win_loss_ratio
    return max(0.0, f)


def capped_kelly_fraction(
    win_prob: float,
    win_loss_ratio: float,
    fractional: float = 0.25,
    cap: float = 0.10,
) -> float:
    f = kelly_fraction(win_prob, win_loss_ratio)
    f *= max(0.0, min(1.0, fractional))
    return min(f, max(0.0, cap))


def atr_stops(price: float, atr: float, cfg: RiskConfig) -> tuple[float, float]:
    """Return (stop_loss, take_profit) for a long entry."""
    stop = max(0.0, price - cfg.atr_stop_mult * atr)
    target = price + cfg.atr_target_mult * atr
    return stop, target


def position_size(
    price: float,
    stop_loss: float,
    cfg: RiskConfig,
) -> tuple[int, float, float, str]:
    """Compute (shares, dollar_size, risk_amount, cap_reason).

    Honors risk_per_trade against stop distance AND max_position_pct.
    The binding constraint is reported in cap_reason.
    """
    if price <= 0:
        return 0, 0.0, 0.0, "bad_price"
    risk_per_share = max(0.0, price - stop_loss)
    if risk_per_share <= 0:
        return 0, 0.0, 0.0, "no_stop_distance"
    risk_budget = cfg.equity * cfg.risk_per_trade
    shares_by_risk = int(risk_budget // risk_per_share)
    max_dollars = cfg.equity * cfg.max_position_pct
    shares_by_weight = int(max_dollars // price)
    shares = min(shares_by_risk, shares_by_weight)
    if shares < cfg.min_shares:
        return 0, 0.0, 0.0, "below_min"
    reason = "risk_per_trade" if shares_by_risk <= shares_by_weight else "max_position_pct"
    dollar_size = shares * price
    risk_amount = shares * risk_per_share
    return shares, dollar_size, risk_amount, reason


def _label_to_winprob(label: str, score: float) -> float:
    """Map signal label + raw score (0..1) to a calibrated win probability.

    Scores are clipped to [0.50, 0.85] for 'watch' so position sizing never
    over-commits on noisy classifier output, and 'skip' is treated as no edge.
    """
    label = (label or "").lower()
    s = max(0.0, min(1.0, float(score)))
    if label == "watch":
        return max(0.50, min(0.85, 0.50 + 0.35 * s))
    if label == "hold":
        return max(0.45, min(0.60, 0.45 + 0.15 * s))
    return 0.0  # skip


def size_pick(
    ticker: str,
    df: pd.DataFrame,
    label: str,
    score: float,
    cfg: Optional[RiskConfig] = None,
) -> SizingResult:
    """End-to-end sizing for one pick from an OHLCV frame."""
    cfg = cfg or RiskConfig()
    price = float(df["close"].iloc[-1])
    a_series = _atr_indicator(df["high"], df["low"], df["close"], n=14).dropna()
    a = float(a_series.iloc[-1]) if not a_series.empty else 0.0
    stop, target = atr_stops(price, a, cfg)
    win_prob = _label_to_winprob(label, score)
    # R-multiple from ATR target/stop distances
    risk_per_share = max(1e-9, price - stop)
    reward_per_share = max(1e-9, target - price)
    b = reward_per_share / risk_per_share
    kelly_raw = kelly_fraction(win_prob, b)
    kelly = capped_kelly_fraction(win_prob, b, cfg.kelly_fraction, cfg.kelly_cap)

    # Kelly-implied dollar size, but never exceed position_size from stop budget
    kelly_dollars = cfg.equity * kelly
    shares_from_risk, dollar_from_risk, risk_amount, cap_reason = position_size(
        price, stop, cfg
    )
    if kelly_dollars <= 0 or label.lower() == "skip":
        shares = 0
        dollar_size = 0.0
        risk_amount = 0.0
        cap_reason = "no_edge" if label.lower() != "skip" else "skip_label"
    else:
        shares_by_kelly = int(kelly_dollars // price)
        shares = min(shares_from_risk, shares_by_kelly)
        if shares < cfg.min_shares:
            shares = 0
            cap_reason = "below_min"
        else:
            dollar_size = shares * price
            risk_amount = shares * risk_per_share
            if shares == shares_by_kelly and shares_by_kelly < shares_from_risk:
                cap_reason = "kelly_cap"
        dollar_size = shares * price
        risk_amount = shares * risk_per_share

    weight = (shares * price) / cfg.equity if cfg.equity > 0 else 0.0
    return SizingResult(
        ticker=ticker,
        price=price,
        atr=a,
        stop_loss=stop,
        take_profit=target,
        risk_per_share=risk_per_share,
        shares=shares,
        dollar_size=shares * price,
        weight=weight,
        risk_amount=risk_amount,
        kelly_suggested=kelly_raw,
        kelly_capped=kelly,
        cap_reason=cap_reason,
    )
