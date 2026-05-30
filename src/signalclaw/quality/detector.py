"""OHLCV anomaly detection."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import List, Tuple
import math
import numpy as np
import pandas as pd


REQUIRED_COLS = ("open", "high", "low", "close", "volume")


@dataclass(frozen=True)
class Anomaly:
    index: str          # ISO date string of the bar
    reasons: Tuple[str, ...]
    severity: float     # 0..3+, higher is worse
    return_z: float
    return_atr_mult: float
    range_iqr_mult: float

    def to_dict(self) -> dict:
        d = asdict(self)
        d["reasons"] = list(self.reasons)
        return d


@dataclass
class DetectorConfig:
    z_threshold: float = 6.0          # robust z above this triggers
    atr_mult_threshold: float = 5.0   # |ret| / ATR above this triggers
    iqr_mult_threshold: float = 4.0   # bar range vs IQR above this triggers
    atr_window: int = 14
    iqr_window: int = 30
    mad_window: int = 60

    def __post_init__(self) -> None:
        for n, v in (("z_threshold", self.z_threshold),
                     ("atr_mult_threshold", self.atr_mult_threshold),
                     ("iqr_mult_threshold", self.iqr_mult_threshold)):
            if v <= 0:
                raise ValueError(f"{n} must be > 0")
        for n in ("atr_window", "iqr_window", "mad_window"):
            v = getattr(self, n)
            if v < 2:
                raise ValueError(f"{n} must be >= 2")


@dataclass(frozen=True)
class AnomalyReport:
    anomalies: Tuple[Anomaly, ...]
    n_bars: int
    n_anomalous: int

    @property
    def rate(self) -> float:
        return self.n_anomalous / self.n_bars if self.n_bars else 0.0

    def to_dict(self) -> dict:
        return {
            "n_bars": self.n_bars,
            "n_anomalous": self.n_anomalous,
            "rate": round(self.rate, 6),
            "anomalies": [a.to_dict() for a in self.anomalies],
        }


def _validate(df: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        raise ValueError(f"frame missing columns: {missing}")


def _atr(df: pd.DataFrame, window: int) -> pd.Series:
    high = df["high"]
    low = df["low"]
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.rolling(window=window, min_periods=max(2, window // 2)).mean()


def _robust_z(series: pd.Series, window: int) -> pd.Series:
    med = series.rolling(window=window, min_periods=max(5, window // 4)).median()
    mad = (series - med).abs().rolling(
        window=window, min_periods=max(5, window // 4)).median()
    # 1.4826 makes MAD a consistent estimator of std for normal data
    denom = (1.4826 * mad).replace(0.0, np.nan)
    return (series - med) / denom


def detect_anomalies(df: pd.DataFrame,
                     config: DetectorConfig | None = None) -> AnomalyReport:
    """Scan an OHLCV frame and return all anomalous bars."""
    _validate(df)
    cfg = config or DetectorConfig()
    if df.empty:
        return AnomalyReport(anomalies=(), n_bars=0, n_anomalous=0)
    df = df.sort_index()
    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    op = df["open"].astype(float)
    vol = df["volume"].astype(float)
    ret = np.log(close / close.shift(1))
    rz = _robust_z(ret, cfg.mad_window)
    atr = _atr(df.astype(float), cfg.atr_window)
    atr_mult = (close.diff().abs() / atr).replace([np.inf, -np.inf], np.nan)
    bar_range = (high - low) / close.replace(0.0, np.nan)
    iqr = bar_range.rolling(window=cfg.iqr_window,
                            min_periods=max(5, cfg.iqr_window // 4)).apply(
        lambda x: np.subtract(*np.percentile(x.dropna(), [75, 25]))
        if x.dropna().size >= 4 else np.nan, raw=False)
    iqr_med = bar_range.rolling(window=cfg.iqr_window,
                                min_periods=max(5, cfg.iqr_window // 4)).median()
    range_iqr_mult = ((bar_range - iqr_med) / iqr.replace(0.0, np.nan)).abs()

    anomalies: List[Anomaly] = []
    # detect duplicate-print runs: open == high == low == close as same prev value
    flat_run_prev: float | None = None
    flat_run_len = 0
    for i, ts in enumerate(df.index):
        reasons: List[str] = []
        o, h, l, c, v = op.iloc[i], high.iloc[i], low.iloc[i], close.iloc[i], vol.iloc[i]
        # structural
        if not (math.isfinite(o) and math.isfinite(h) and math.isfinite(l)
                and math.isfinite(c)):
            reasons.append("non_finite_price")
        if min(o, h, l, c) <= 0:
            reasons.append("non_positive_price")
        if h < l:
            reasons.append("high_lt_low")
        if not (l - 1e-9 <= c <= h + 1e-9):
            reasons.append("close_outside_range")
        if not (l - 1e-9 <= o <= h + 1e-9):
            reasons.append("open_outside_range")
        if v < 0:
            reasons.append("negative_volume")
        if v == 0:
            reasons.append("zero_volume")
        # flat duplicate-print streak: 3+ identical OHLC
        if o == h == l == c and c == flat_run_prev:
            flat_run_len += 1
            if flat_run_len >= 2:   # this is the 3rd bar in a row
                reasons.append("flat_duplicate_print")
        else:
            flat_run_prev = c if o == h == l == c else None
            flat_run_len = 0
        # statistical
        z = float(rz.iloc[i]) if pd.notna(rz.iloc[i]) else 0.0
        a = float(atr_mult.iloc[i]) if pd.notna(atr_mult.iloc[i]) else 0.0
        rg = float(range_iqr_mult.iloc[i]) if pd.notna(range_iqr_mult.iloc[i]) else 0.0
        if abs(z) >= cfg.z_threshold:
            reasons.append("return_z")
        if a >= cfg.atr_mult_threshold:
            reasons.append("return_atr")
        if rg >= cfg.iqr_mult_threshold:
            reasons.append("range_iqr")
        if not reasons:
            continue
        severity = 0.0
        if cfg.z_threshold > 0:
            severity += abs(z) / cfg.z_threshold
        if cfg.atr_mult_threshold > 0:
            severity += a / cfg.atr_mult_threshold
        if cfg.iqr_mult_threshold > 0:
            severity += rg / cfg.iqr_mult_threshold
        # structural problems are always severe
        structural = {"non_finite_price", "non_positive_price", "high_lt_low",
                      "close_outside_range", "open_outside_range",
                      "negative_volume"}
        if any(r in structural for r in reasons):
            severity = max(severity, 3.0)
        anomalies.append(Anomaly(
            index=str(getattr(ts, "isoformat", lambda: ts)()),
            reasons=tuple(reasons),
            severity=round(severity, 4),
            return_z=round(z, 4),
            return_atr_mult=round(a, 4),
            range_iqr_mult=round(rg, 4),
        ))
    return AnomalyReport(
        anomalies=tuple(anomalies),
        n_bars=len(df),
        n_anomalous=len(anomalies),
    )


def clean_frame(df: pd.DataFrame, report: AnomalyReport,
                min_severity: float = 1.5) -> pd.DataFrame:
    """Return a copy of ``df`` with anomalies at or above ``min_severity`` removed."""
    if df.empty or not report.anomalies:
        return df.copy()
    drop_idx = {a.index for a in report.anomalies if a.severity >= min_severity}
    if not drop_idx:
        return df.copy()
    keep = [i for i in df.index
            if str(getattr(i, "isoformat", lambda: i)()) not in drop_idx]
    return df.loc[keep].copy()
