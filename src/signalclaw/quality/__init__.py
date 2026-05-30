"""Data-quality checks for OHLCV frames.

Detects anomalous bars (bad ticks, fat fingers, stale data) so they can
be flagged or removed before they feed features, backtests, or signals.
Three orthogonal detectors, voted as severity:

* ``return_z`` -- robust z-score of daily log returns using median and MAD.
* ``return_atr`` -- abs daily change as a multiple of trailing ATR(14).
* ``range_iqr`` -- intra-bar (high-low)/close vs the rolling IQR.

Plus structural sanity checks: non-positive prices, high < low, close
outside [low, high], zero volume on non-holiday bars, and exact-duplicate
prints (open=high=low=close across consecutive bars).
"""
from .detector import (
    Anomaly,
    AnomalyReport,
    DetectorConfig,
    detect_anomalies,
    clean_frame,
)

__all__ = [
    "Anomaly",
    "AnomalyReport",
    "DetectorConfig",
    "detect_anomalies",
    "clean_frame",
]
