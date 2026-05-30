from __future__ import annotations
import numpy as np
import pandas as pd
import pytest
from signalclaw.quality import (
    detect_anomalies, clean_frame, DetectorConfig, AnomalyReport,
)


def _calm_frame(n: int = 200, seed: int = 7) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rets = rng.normal(0, 0.005, size=n)
    px = 100.0 * np.exp(np.cumsum(rets))
    idx = pd.date_range("2024-01-01", periods=n, freq="B")
    return pd.DataFrame({
        "open": px * (1 + rng.normal(0, 0.001, n)),
        "high": px * (1 + np.abs(rng.normal(0, 0.002, n))),
        "low": px * (1 - np.abs(rng.normal(0, 0.002, n))),
        "close": px,
        "volume": rng.integers(800_000, 1_200_000, n),
    }, index=idx)


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    # enforce high >= max(open, close), low <= min(open, close)
    df = df.copy()
    df["high"] = df[["high", "open", "close"]].max(axis=1)
    df["low"] = df[["low", "open", "close"]].min(axis=1)
    return df


def test_calm_series_produces_few_or_no_anomalies():
    df = _normalize(_calm_frame())
    rep = detect_anomalies(df)
    assert rep.n_bars == 200
    assert rep.rate < 0.02


def test_fat_finger_return_spike_is_caught():
    df = _normalize(_calm_frame())
    # inject 30% jump on bar 150
    bad_idx = df.index[150]
    df.loc[bad_idx, "close"] *= 1.30
    df.loc[bad_idx, "high"] = max(df.loc[bad_idx, "high"],
                                  df.loc[bad_idx, "close"])
    rep = detect_anomalies(df)
    hits = [a for a in rep.anomalies if str(bad_idx.isoformat()) == a.index]
    assert len(hits) == 1
    assert "return_z" in hits[0].reasons or "return_atr" in hits[0].reasons
    assert hits[0].severity >= 1.0


def test_structural_high_lt_low_flagged_as_severe():
    df = _normalize(_calm_frame())
    bad = df.index[10]
    df.loc[bad, "high"] = 1.0
    df.loc[bad, "low"] = 999.0
    rep = detect_anomalies(df)
    hits = [a for a in rep.anomalies if a.index == bad.isoformat()]
    assert hits and "high_lt_low" in hits[0].reasons
    assert hits[0].severity >= 3.0


def test_close_outside_range_flagged():
    df = _normalize(_calm_frame())
    bad = df.index[20]
    df.loc[bad, "close"] = df.loc[bad, "high"] * 2.0
    rep = detect_anomalies(df)
    reasons = {r for a in rep.anomalies if a.index == bad.isoformat()
               for r in a.reasons}
    assert "close_outside_range" in reasons


def test_zero_volume_flagged_but_low_severity():
    df = _normalize(_calm_frame())
    bad = df.index[30]
    df.loc[bad, "volume"] = 0
    rep = detect_anomalies(df)
    hits = [a for a in rep.anomalies if a.index == bad.isoformat()]
    assert hits and "zero_volume" in hits[0].reasons


def test_negative_price_flagged_as_severe():
    df = _normalize(_calm_frame())
    bad = df.index[40]
    df.loc[bad, "close"] = -1.0
    df.loc[bad, "low"] = -2.0
    rep = detect_anomalies(df)
    hits = [a for a in rep.anomalies if a.index == bad.isoformat()]
    assert hits and "non_positive_price" in hits[0].reasons
    assert hits[0].severity >= 3.0


def test_flat_duplicate_print_streak_flagged():
    df = _normalize(_calm_frame())
    px = 100.0
    for i in (60, 61, 62, 63):
        ts = df.index[i]
        df.loc[ts, "open"] = px
        df.loc[ts, "high"] = px
        df.loc[ts, "low"] = px
        df.loc[ts, "close"] = px
    rep = detect_anomalies(df)
    # only bars from the 3rd onwards in the streak are flagged
    flagged = [a for a in rep.anomalies
               if "flat_duplicate_print" in a.reasons]
    assert len(flagged) >= 2


def test_clean_frame_drops_high_severity_bars_only():
    df = _normalize(_calm_frame())
    bad = df.index[100]
    df.loc[bad, "high"] = 1.0
    df.loc[bad, "low"] = 999.0
    rep = detect_anomalies(df)
    cleaned = clean_frame(df, rep, min_severity=2.0)
    assert bad not in cleaned.index
    assert len(cleaned) == len(df) - 1


def test_clean_frame_no_op_when_no_anomalies():
    df = _normalize(_calm_frame())
    rep = AnomalyReport(anomalies=(), n_bars=len(df), n_anomalous=0)
    cleaned = clean_frame(df, rep)
    assert len(cleaned) == len(df)


def test_empty_frame_returns_empty_report():
    df = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    rep = detect_anomalies(df)
    assert rep.n_bars == 0
    assert rep.n_anomalous == 0
    assert rep.rate == 0.0


def test_missing_column_raises():
    df = pd.DataFrame({"open": [1.0], "high": [1.0], "low": [1.0],
                       "close": [1.0]})  # no volume
    with pytest.raises(ValueError):
        detect_anomalies(df)


def test_detector_config_validates_inputs():
    with pytest.raises(ValueError):
        DetectorConfig(z_threshold=0.0)
    with pytest.raises(ValueError):
        DetectorConfig(atr_window=1)


def test_report_to_dict_contains_rate_and_anomaly_dicts():
    df = _normalize(_calm_frame())
    bad = df.index[50]
    df.loc[bad, "close"] *= 1.5
    df.loc[bad, "high"] = df.loc[bad, "close"]
    rep = detect_anomalies(df)
    d = rep.to_dict()
    assert d["n_bars"] == 200
    assert "rate" in d and 0.0 <= d["rate"] <= 1.0
    assert isinstance(d["anomalies"], list) and d["anomalies"]
    assert "reasons" in d["anomalies"][0]
