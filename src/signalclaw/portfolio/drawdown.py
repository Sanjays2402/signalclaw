"""Portfolio-level drawdown circuit breaker.

Computes equity curve from trades + price history, tracks running peak, and
emits a guard decision: when the current drawdown from peak exceeds a
configured threshold, new buy signals should be suppressed until equity
recovers above a configured re-arm fraction of the peak.

Pure functions: no I/O. The caller supplies trades, price history, and
config. Persistence of the guard's last decision is handled by GuardStore.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Sequence
import json
import threading

import pandas as pd

from .position import Trade, TradeSide


@dataclass(frozen=True)
class DrawdownConfig:
    """Threshold expressed as positive fractions of peak equity.

    trigger:  drawdown >= trigger  -> guard trips (block new buys)
    rearm:    equity >= peak * (1 - rearm) -> guard clears
    min_history_days: require at least this many equity points before tripping
    """
    trigger: float = 0.10
    rearm: float = 0.05
    min_history_days: int = 5

    def __post_init__(self) -> None:
        if not 0 < self.trigger <= 1:
            raise ValueError("trigger must be in (0, 1]")
        if not 0 <= self.rearm < self.trigger:
            raise ValueError("rearm must be in [0, trigger)")
        if self.min_history_days < 1:
            raise ValueError("min_history_days must be >= 1")


@dataclass
class DrawdownState:
    as_of: str
    equity: float
    peak: float
    peak_date: str
    drawdown: float
    tripped: bool
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DrawdownGuardReport:
    state: DrawdownState
    config: DrawdownConfig
    equity_curve: List[Dict[str, float]]  # [{date, equity}]

    def to_dict(self) -> dict:
        return {
            "state": self.state.to_dict(),
            "config": asdict(self.config),
            "equity_curve": list(self.equity_curve),
        }


def _daily_close_lookup(
    price_history: Dict[str, "pd.DataFrame"],
) -> Dict[str, "pd.Series"]:
    """Extract a per-ticker close series indexed by date string."""
    out: Dict[str, pd.Series] = {}
    for t, df in price_history.items():
        if df is None or df.empty:
            continue
        s = df["close"] if "close" in df.columns else df.iloc[:, 0]
        s = s.copy()
        s.index = pd.to_datetime(s.index).normalize()
        out[t.upper()] = s
    return out


def compute_equity_curve(
    trades: Sequence[Trade],
    price_history: Dict[str, "pd.DataFrame"],
    cash: float = 0.0,
) -> "pd.Series":
    """Equity = realized cash + mark-to-market of open lots, daily.

    Date range spans first trade through the latest date present in any of
    the supplied price histories. Tickers with no price data fall back to
    last trade price.
    """
    if not trades:
        return pd.Series(dtype=float)

    closes = _daily_close_lookup(price_history)
    sorted_trades = sorted(trades, key=lambda t: t.date)
    start = pd.Timestamp(sorted_trades[0].date).normalize()
    end_candidates = [pd.Timestamp(t.date).normalize() for t in sorted_trades]
    for s in closes.values():
        if len(s):
            end_candidates.append(s.index.max())
    end = max(end_candidates)
    if end < start:
        end = start
    idx = pd.date_range(start=start, end=end, freq="D")

    # Per-day running state: cash, holdings { ticker: (qty, avg_cost) }.
    holdings: Dict[str, Dict[str, float]] = {}
    cash_balance = float(cash)
    realized_pnl = 0.0
    trade_iter = iter(sorted_trades)
    next_trade = next(trade_iter, None)
    last_known_price: Dict[str, float] = {}

    equity_values: List[float] = []
    for day in idx:
        while next_trade is not None and pd.Timestamp(next_trade.date).normalize() <= day:
            t = next_trade.ticker.upper()
            if next_trade.side == TradeSide.BUY:
                q = float(next_trade.quantity)
                price = float(next_trade.price)
                cost = q * price + float(next_trade.fees)
                cash_balance -= cost
                h = holdings.setdefault(t, {"qty": 0.0, "cost": 0.0})
                new_qty = h["qty"] + q
                h["cost"] = (h["cost"] * h["qty"] + q * price) / new_qty if new_qty > 0 else 0.0
                h["qty"] = new_qty
            else:  # SELL
                q = float(next_trade.quantity)
                price = float(next_trade.price)
                proceeds = q * price - float(next_trade.fees)
                cash_balance += proceeds
                h = holdings.setdefault(t, {"qty": 0.0, "cost": 0.0})
                realized_pnl += q * (price - h["cost"]) - float(next_trade.fees)
                h["qty"] = max(0.0, h["qty"] - q)
                if h["qty"] <= 1e-9:
                    h["qty"] = 0.0
            last_known_price[t] = float(next_trade.price)
            next_trade = next(trade_iter, None)

        # Mark to market
        mv = 0.0
        for t, h in holdings.items():
            if h["qty"] <= 0:
                continue
            s = closes.get(t)
            price = None
            if s is not None and len(s):
                ss = s.loc[s.index <= day]
                if len(ss):
                    price = float(ss.iloc[-1])
            if price is None:
                price = last_known_price.get(t, h["cost"])
            mv += h["qty"] * price
        equity_values.append(cash_balance + mv)

    return pd.Series(equity_values, index=idx, name="equity")


def evaluate_drawdown(
    equity: "pd.Series",
    config: DrawdownConfig,
    previously_tripped: bool = False,
) -> DrawdownState:
    """Return the guard state for the latest point in the equity series.

    Re-arm hysteresis: if previously tripped, the guard stays tripped until
    equity recovers above peak * (1 - rearm). If not previously tripped, it
    trips when drawdown >= trigger.
    """
    if equity is None or len(equity) == 0:
        now = datetime.now(timezone.utc).date().isoformat()
        return DrawdownState(
            as_of=now, equity=0.0, peak=0.0, peak_date=now,
            drawdown=0.0, tripped=False, reason="no equity history",
        )
    running_peak = equity.cummax()
    last_equity = float(equity.iloc[-1])
    last_peak = float(running_peak.iloc[-1])
    peak_date = str(equity.index[equity.argmax()].date())
    drawdown = 0.0 if last_peak <= 0 else max(0.0, 1.0 - (last_equity / last_peak))
    as_of = str(equity.index[-1].date())

    if len(equity) < config.min_history_days:
        return DrawdownState(
            as_of=as_of, equity=last_equity, peak=last_peak, peak_date=peak_date,
            drawdown=drawdown, tripped=False,
            reason=f"insufficient history ({len(equity)} < {config.min_history_days})",
        )

    rearm_threshold = config.rearm
    if previously_tripped:
        if drawdown > rearm_threshold:
            return DrawdownState(
                as_of=as_of, equity=last_equity, peak=last_peak,
                peak_date=peak_date, drawdown=drawdown, tripped=True,
                reason=f"still below re-arm: drawdown {drawdown:.2%} > rearm {rearm_threshold:.2%}",
            )
        return DrawdownState(
            as_of=as_of, equity=last_equity, peak=last_peak,
            peak_date=peak_date, drawdown=drawdown, tripped=False,
            reason=f"re-armed: drawdown {drawdown:.2%} <= rearm {rearm_threshold:.2%}",
        )

    if drawdown >= config.trigger:
        return DrawdownState(
            as_of=as_of, equity=last_equity, peak=last_peak,
            peak_date=peak_date, drawdown=drawdown, tripped=True,
            reason=f"drawdown {drawdown:.2%} >= trigger {config.trigger:.2%}",
        )
    return DrawdownState(
        as_of=as_of, equity=last_equity, peak=last_peak,
        peak_date=peak_date, drawdown=drawdown, tripped=False,
        reason=f"within tolerance: drawdown {drawdown:.2%} < trigger {config.trigger:.2%}",
    )


def evaluate_guard(
    trades: Sequence[Trade],
    price_history: Dict[str, "pd.DataFrame"],
    config: DrawdownConfig,
    previously_tripped: bool = False,
    cash: float = 0.0,
) -> DrawdownGuardReport:
    eq = compute_equity_curve(trades, price_history, cash=cash)
    state = evaluate_drawdown(eq, config, previously_tripped=previously_tripped)
    curve = [
        {"date": str(d.date()), "equity": float(v)}
        for d, v in eq.items()
    ]
    return DrawdownGuardReport(state=state, config=config, equity_curve=curve)


def filter_picks(picks: Sequence[dict], guard_state: DrawdownState) -> List[dict]:
    """Drop or downgrade buy-side picks when the guard is tripped.

    A pick is considered buy-side when its label is "watch" (case-insensitive).
    When tripped, watch picks are demoted to "hold" and tagged with the guard
    reason in their rationale_flags (or appended via 'guard' field).
    """
    if not guard_state.tripped:
        return list(picks)
    tag = f"drawdown_guard_tripped:{guard_state.drawdown:.2%}"
    out: List[dict] = []
    for p in picks:
        label = str(p.get("label", "")).lower()
        if label == "watch":
            new = dict(p)
            new["label"] = "hold"
            risk = list(new.get("risk_flags") or [])
            if tag not in risk:
                risk.append(tag)
            new["risk_flags"] = risk
            if "rationale_flags" in new:
                rf = list(new.get("rationale_flags") or [])
                if tag not in rf:
                    rf.append(tag)
                new["rationale_flags"] = rf
            out.append(new)
        else:
            out.append(dict(p))
    return out


class DrawdownGuardStore:
    """Persists the last-known tripped flag for hysteresis across runs."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"tripped": False, "history": []}, indent=2))

    def _read(self) -> dict:
        return json.loads(self.path.read_text() or '{"tripped": false, "history": []}')

    def previously_tripped(self) -> bool:
        return bool(self._read().get("tripped", False))

    def record(self, state: DrawdownState) -> None:
        with self._lock:
            raw = self._read()
            raw["tripped"] = bool(state.tripped)
            hist = list(raw.get("history") or [])
            hist.append(state.to_dict())
            raw["history"] = hist[-200:]
            self.path.write_text(json.dumps(raw, indent=2, sort_keys=True))

    def history(self) -> List[dict]:
        return list(self._read().get("history") or [])

    def clear(self) -> None:
        with self._lock:
            self.path.write_text(json.dumps({"tripped": False, "history": []}, indent=2))
