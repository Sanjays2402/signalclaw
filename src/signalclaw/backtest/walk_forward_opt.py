"""Walk-forward parameter optimization for simple rule-based strategies.

The ML walk-forward backtest already covers the model path. This module
adds a transparent, rule-based optimizer useful for sanity checks and
robust-parameter discovery without relying on a fit-prone classifier.

Strategy template (long-only, no leverage):

    signal[t] = 1 if SMA(close, fast) > SMA(close, slow)
                     and RSI(close, rsi_period) > rsi_min
                else 0

The optimizer slides a (train, test) window over the price series. In
each fold it grid-searches the supplied parameter ranges on the train
slice, picks the in-sample best-Sharpe params, then records the
out-of-sample Sharpe and return on the test slice. The output reports
the per-fold OOS metrics, the parameters chosen most often, and the
aggregate OOS Sharpe / hit rate.

This avoids look-ahead by selection: the OOS slice never participates
in scoring the chosen params.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, asdict
from itertools import product
from typing import List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from .metrics import sharpe, max_drawdown, hit_rate
from .costs import TransactionCostModel


# --- indicators (local to keep this module self-contained) ---------------

def _sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(int(n), min_periods=int(n)).mean()


def _rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0.0)
    down = (-delta).clip(lower=0.0)
    roll_up = up.ewm(alpha=1 / n, min_periods=n, adjust=False).mean()
    roll_dn = down.ewm(alpha=1 / n, min_periods=n, adjust=False).mean()
    rs = roll_up / roll_dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


# --- strategy ------------------------------------------------------------

@dataclass(frozen=True)
class Params:
    fast: int
    slow: int
    rsi_period: int
    rsi_min: float

    def is_valid(self) -> bool:
        return self.fast < self.slow and self.fast > 0 and self.rsi_period > 1

    def as_tuple(self) -> Tuple[int, int, int, float]:
        return (self.fast, self.slow, self.rsi_period, float(self.rsi_min))


def _signal(close: pd.Series, p: Params) -> pd.Series:
    fast = _sma(close, p.fast)
    slow = _sma(close, p.slow)
    rsi = _rsi(close, p.rsi_period)
    sig = ((fast > slow) & (rsi > p.rsi_min)).astype(float)
    return sig.fillna(0.0)


def _returns(close: pd.Series, position: pd.Series,
             costs: TransactionCostModel) -> pd.Series:
    daily = close.pct_change().fillna(0.0)
    held = position.shift(1).fillna(0.0)
    strat = held * daily
    turnover = position.diff().abs().fillna(0.0)
    return strat - turnover * costs.cost(1.0)


@dataclass
class Fold:
    train_start: str
    train_end: str
    test_start: str
    test_end: str
    chosen: Tuple[int, int, int, float]
    train_sharpe: float
    test_sharpe: float
    test_return: float
    test_hit_rate: float
    test_max_drawdown: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WalkForwardOptResult:
    folds: List[Fold]
    most_common_params: Optional[Tuple[int, int, int, float]]
    most_common_share: float
    median_test_sharpe: float
    mean_test_sharpe: float
    mean_test_return: float
    n_folds: int
    grid_size: int

    def to_dict(self) -> dict:
        d = asdict(self)
        d["folds"] = [f.to_dict() for f in self.folds]
        return d


# --- optimizer -----------------------------------------------------------

def _grid(fast: Sequence[int], slow: Sequence[int],
          rsi_period: Sequence[int], rsi_min: Sequence[float]) -> List[Params]:
    out: List[Params] = []
    for f, s, rp, rm in product(fast, slow, rsi_period, rsi_min):
        p = Params(fast=int(f), slow=int(s), rsi_period=int(rp), rsi_min=float(rm))
        if p.is_valid():
            out.append(p)
    return out


def walk_forward_optimize(
    close: pd.Series,
    train_window: int = 252,
    test_window: int = 63,
    step: Optional[int] = None,
    fast: Sequence[int] = (5, 10, 20),
    slow: Sequence[int] = (20, 50, 100),
    rsi_period: Sequence[int] = (7, 14),
    rsi_min: Sequence[float] = (0.0, 40.0, 50.0),
    costs: Optional[TransactionCostModel] = None,
) -> WalkForwardOptResult:
    """Run walk-forward parameter optimization over a price series."""
    close = pd.Series(close).dropna().astype(float)
    if step is None:
        step = test_window
    costs = costs or TransactionCostModel()
    grid = _grid(fast, slow, rsi_period, rsi_min)
    if not grid:
        raise ValueError("empty parameter grid (check fast<slow)")

    folds: List[Fold] = []
    start = 0
    while start + train_window + test_window <= len(close):
        train = close.iloc[start:start + train_window]
        test = close.iloc[start + train_window:start + train_window + test_window]

        best_p: Optional[Params] = None
        best_sh = -np.inf
        for p in grid:
            need = max(p.slow, p.rsi_period) + 5
            if len(train) < need:
                continue
            sig = _signal(train, p)
            r = _returns(train, sig, costs)
            sh = sharpe(r)
            if np.isfinite(sh) and sh > best_sh:
                best_sh = sh
                best_p = p
        if best_p is None:
            start += step
            continue

        # OOS evaluation: we need history to seed indicators, so include
        # the trailing train slice when computing signals, then restrict
        # the returns series to the test window only.
        combined = pd.concat([train, test])
        sig_full = _signal(combined, best_p)
        ret_full = _returns(combined, sig_full, costs)
        ret_oos = ret_full.loc[test.index]
        equity = (1 + ret_oos).cumprod()
        folds.append(Fold(
            train_start=str(train.index[0].date()) if hasattr(train.index[0], "date") else str(train.index[0]),
            train_end=str(train.index[-1].date()) if hasattr(train.index[-1], "date") else str(train.index[-1]),
            test_start=str(test.index[0].date()) if hasattr(test.index[0], "date") else str(test.index[0]),
            test_end=str(test.index[-1].date()) if hasattr(test.index[-1], "date") else str(test.index[-1]),
            chosen=best_p.as_tuple(),
            train_sharpe=float(best_sh),
            test_sharpe=float(sharpe(ret_oos)),
            test_return=float(equity.iloc[-1] - 1.0) if len(equity) else 0.0,
            test_hit_rate=float(hit_rate(ret_oos[ret_oos != 0])),
            test_max_drawdown=float(max_drawdown(equity)) if len(equity) else 0.0,
        ))
        start += step

    counter: Counter = Counter(f.chosen for f in folds)
    most_common: Optional[Tuple[int, int, int, float]] = None
    share = 0.0
    if folds:
        most_common, count = counter.most_common(1)[0]
        share = count / len(folds)

    finite_sharpes = [f.test_sharpe for f in folds if np.isfinite(f.test_sharpe)]
    return WalkForwardOptResult(
        folds=folds,
        most_common_params=most_common,
        most_common_share=share,
        median_test_sharpe=float(np.median(finite_sharpes)) if finite_sharpes else 0.0,
        mean_test_sharpe=float(np.mean(finite_sharpes)) if finite_sharpes else 0.0,
        mean_test_return=float(np.mean([f.test_return for f in folds])) if folds else 0.0,
        n_folds=len(folds),
        grid_size=len(grid),
    )
