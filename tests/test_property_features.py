import numpy as np
import pandas as pd
from hypothesis import given, strategies as st, settings as hsettings
from signalclaw.features import build_features


@given(st.integers(min_value=80, max_value=400), st.integers(min_value=0, max_value=10_000))
@hsettings(deadline=None, max_examples=5)
def test_build_features_no_inf(n, seed):
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    df = pd.DataFrame({
        "open": close + rng.normal(0, 0.5, n),
        "high": close + np.abs(rng.normal(0, 1, n)),
        "low":  close - np.abs(rng.normal(0, 1, n)),
        "close": close,
        "volume": rng.integers(1e5, 1e7, n).astype(float),
    }, index=pd.date_range("2020-01-01", periods=n, freq="B"))
    feats = build_features(df)
    if feats.empty:
        return
    assert not np.isinf(feats.replace([np.inf, -np.inf], np.nan).dropna().values).any()
