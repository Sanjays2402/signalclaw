import numpy as np
import pandas as pd
import pytest

from signalclaw.backtest import walk_forward_optimize, Params
from signalclaw.backtest.walk_forward_opt import _signal, _grid


def _trending_prices(n: int = 800, seed: int = 7) -> pd.Series:
    rng = np.random.default_rng(seed)
    # Drift + noise so a fast/slow crossover has *some* signal
    rets = rng.normal(0.0006, 0.012, n)
    rets[100:200] += 0.003   # bull burst
    rets[400:500] -= 0.003   # drawdown
    prices = 100 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2020-01-01", periods=n, freq="B")
    return pd.Series(prices, index=idx, name="close")


def test_grid_rejects_invalid_fast_ge_slow():
    g = _grid([20], [10], [14], [0.0])  # fast >= slow
    assert g == []


def test_grid_keeps_valid_combos():
    g = _grid([5, 10], [20, 50], [14], [0.0, 40.0])
    # all (f<s) combos kept
    assert len(g) == 2 * 2 * 1 * 2


def test_signal_is_zero_when_indicators_unset():
    s = pd.Series([100.0, 101.0, 102.0])
    sig = _signal(s, Params(fast=5, slow=20, rsi_period=14, rsi_min=0.0))
    # no full window -> all zeros
    assert (sig == 0).all()


def test_walk_forward_runs_and_reports_folds():
    s = _trending_prices()
    res = walk_forward_optimize(
        s, train_window=200, test_window=50,
        fast=(5, 10), slow=(20, 50), rsi_period=(14,), rsi_min=(0.0, 50.0),
    )
    assert res.n_folds > 0
    assert res.grid_size == 2 * 2 * 1 * 2
    for f in res.folds:
        assert f.test_start <= f.test_end
        assert isinstance(f.chosen, tuple) and len(f.chosen) == 4
    assert -3 <= res.median_test_sharpe <= 3
    # mean_test_return is a real float, finite
    assert np.isfinite(res.mean_test_return)


def test_most_common_share_in_zero_one():
    s = _trending_prices()
    res = walk_forward_optimize(s, train_window=200, test_window=50,
                                 fast=(5,), slow=(50,), rsi_period=(14,),
                                 rsi_min=(0.0,))
    # single grid combo -> share = 1.0
    assert res.most_common_share == 1.0
    assert res.most_common_params == (5, 50, 14, 0.0)


def test_walk_forward_raises_on_empty_grid():
    s = _trending_prices()
    with pytest.raises(ValueError):
        walk_forward_optimize(s, fast=(50,), slow=(20,))


def test_walk_forward_handles_short_series():
    s = _trending_prices(n=100)
    res = walk_forward_optimize(s, train_window=200, test_window=50)
    # not enough data -> no folds, but no crash
    assert res.n_folds == 0
    assert res.most_common_params is None
    assert res.most_common_share == 0.0
