from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
import pandas as pd

from .metrics import sharpe, sortino, max_drawdown, hit_rate, cagr
from .costs import TransactionCostModel
from ..features import build_features
from ..models import WatchHoldSkipClassifier, ReturnRegressor, make_labels


@dataclass
class BacktestResult:
    equity: pd.Series
    returns: pd.Series
    positions: pd.Series
    sharpe: float
    sortino: float
    max_drawdown: float
    hit_rate: float
    cagr: float
    n_trades: int
    metadata: dict = field(default_factory=dict)

    def summary(self) -> dict:
        return {
            "sharpe": round(self.sharpe, 3),
            "sortino": round(self.sortino, 3),
            "max_drawdown": round(self.max_drawdown, 3),
            "hit_rate": round(self.hit_rate, 3),
            "cagr": round(self.cagr, 3),
            "n_trades": self.n_trades,
        }


class WalkForwardBacktest:
    """Walk-forward backtest with no look-ahead. Trains on rolling window,
    predicts next step, takes long-only position when label=watch."""

    def __init__(self,
                 train_window: int = 252,
                 step: int = 21,
                 horizon: int = 5,
                 costs: TransactionCostModel | None = None):
        self.train_window = train_window
        self.step = step
        self.horizon = horizon
        self.costs = costs or TransactionCostModel()

    def run(self, ohlcv: pd.DataFrame, sentiment: pd.Series | None = None) -> BacktestResult:
        feats = build_features(ohlcv, sentiment=sentiment)
        if feats.empty:
            return BacktestResult(pd.Series(dtype=float), pd.Series(dtype=float),
                                  pd.Series(dtype=float), 0, 0, 0, 0, 0, 0)
        labels = make_labels(ohlcv["close"], horizon=self.horizon)
        df = feats.join(labels, how="inner").dropna()
        if len(df) < self.train_window + self.step + self.horizon + 5:
            return BacktestResult(pd.Series(dtype=float), pd.Series(dtype=float),
                                  pd.Series(dtype=float), 0, 0, 0, 0, 0, 0)
        feat_cols = [c for c in df.columns if c not in ("label", "fwd_ret")]
        position = pd.Series(0.0, index=df.index)
        n_trades = 0
        start = self.train_window
        while start + self.step <= len(df):
            train = df.iloc[start - self.train_window:start]
            test = df.iloc[start:start + self.step]
            clf = WatchHoldSkipClassifier()
            reg = ReturnRegressor()
            try:
                clf.fit(train[feat_cols], train["label"])
                reg.fit(train[feat_cols], train["fwd_ret"])
            except Exception:
                start += self.step
                continue
            proba = clf.predict_proba(test[feat_cols])
            exp = reg.predict(test[feat_cols])
            score = (proba[:, 2] - proba[:, 0]) + np.tanh(exp * 10) * 0.5
            for i, idx in enumerate(test.index):
                position.loc[idx] = 1.0 if score[i] > 0.2 else 0.0
            start += self.step
        daily_ret = ohlcv["close"].pct_change().reindex(position.index).fillna(0.0)
        strat = position.shift(1).fillna(0.0) * daily_ret
        turnover = position.diff().abs().fillna(0.0)
        strat = strat - turnover * self.costs.cost(1.0)
        n_trades = int(turnover.gt(0).sum())
        equity = (1 + strat).cumprod()
        return BacktestResult(
            equity=equity,
            returns=strat,
            positions=position,
            sharpe=sharpe(strat),
            sortino=sortino(strat),
            max_drawdown=max_drawdown(equity),
            hit_rate=hit_rate(strat[strat != 0]),
            cagr=cagr(equity),
            n_trades=n_trades,
            metadata={"train_window": self.train_window, "step": self.step, "horizon": self.horizon},
        )
