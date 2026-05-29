import numpy as np, pandas as pd
from signalclaw.features.returns import log_returns, simple_returns, rolling_volatility, volatility_regime


def test_log_returns_zero_for_flat():
    s = pd.Series([100.0] * 50)
    assert log_returns(s).dropna().abs().max() < 1e-12


def test_vol_regime_values():
    rng = np.random.default_rng(0)
    s = pd.Series(100 + np.cumsum(rng.normal(0, 1, 500)))
    vol = rolling_volatility(s, 20)
    reg = volatility_regime(vol)
    assert set(reg.unique()).issubset({-1, 0, 1})
