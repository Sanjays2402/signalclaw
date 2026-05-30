"""Sector rotation: relative strength scoring and rotation calls.

Given a dict of {ticker -> close-price Series}, group tickers into sectors
(using the built-in or a caller-supplied map) and compute a relative
strength score for each sector versus a benchmark series.

Score components, per sector, weighted by lookback:
  - 1m, 3m, 6m total returns (defaults: 21, 63, 126 trading days)
  - linear-regression slope of the relative price line (rs vs benchmark)
  - breadth: fraction of tickers in the sector outperforming the benchmark
    over the medium window

Composite score = sum of weighted percentile ranks of each component across
sectors. Rotation call buckets the top tertile as "overweight", bottom tertile
as "underweight", middle as "neutral". The breakdown table preserves the
individual component values so callers can audit the recommendation.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

from ..portfolio.sectors import DEFAULT_SECTOR_MAP


DEFAULT_BENCHMARK = "SPY"
DEFAULT_LOOKBACKS = (21, 63, 126)
DEFAULT_LOOKBACK_WEIGHTS = (0.2, 0.4, 0.4)
DEFAULT_SLOPE_WEIGHT = 0.15
DEFAULT_BREADTH_WEIGHT = 0.15
DEFAULT_RETURN_WEIGHT = 0.7  # 0.7 across lookbacks, split by DEFAULT_LOOKBACK_WEIGHTS
VALID_CALLS = ("overweight", "neutral", "underweight")


@dataclass
class SectorScore:
    sector: str
    n_tickers: int
    ret_1m: float
    ret_3m: float
    ret_6m: float
    rs_slope: float          # slope of relative-strength line, per day
    breadth: float           # fraction outperforming benchmark over 3m
    composite: float         # weighted percentile composite, 0..1
    call: str                # overweight | neutral | underweight
    members: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


@dataclass
class RotationReport:
    benchmark: str
    asof: str                # last date in the panel
    overweight: List[str]
    underweight: List[str]
    scores: List[SectorScore]
    skipped_unknown_sector: List[str]
    skipped_short_history: List[str]

    def to_dict(self) -> Dict:
        return {
            "benchmark": self.benchmark,
            "asof": self.asof,
            "overweight": list(self.overweight),
            "underweight": list(self.underweight),
            "scores": [s.to_dict() for s in self.scores],
            "skipped_unknown_sector": list(self.skipped_unknown_sector),
            "skipped_short_history": list(self.skipped_short_history),
        }


def _total_return(series: pd.Series, days: int) -> Optional[float]:
    s = series.dropna()
    if len(s) <= days:
        return None
    start = float(s.iloc[-(days + 1)])
    end = float(s.iloc[-1])
    if start <= 0:
        return None
    return end / start - 1.0


def _rs_slope(series: pd.Series, benchmark: pd.Series, days: int) -> Optional[float]:
    """Slope (per day) of log(series / benchmark) over the last ``days``."""
    df = pd.concat([series, benchmark], axis=1, join="inner").dropna()
    if len(df) <= days:
        return None
    df = df.iloc[-(days + 1):]
    col_s, col_b = df.columns[0], df.columns[1]
    rs = np.log(df[col_s].astype(float) / df[col_b].astype(float))
    x = np.arange(len(rs), dtype=float)
    # Simple least squares slope
    x_mean = x.mean()
    y_mean = float(rs.mean())
    denom = float(((x - x_mean) ** 2).sum())
    if denom == 0.0:
        return 0.0
    return float(((x - x_mean) * (rs.values - y_mean)).sum() / denom)


def _percentile_ranks(values: Sequence[float]) -> List[float]:
    """Return percentile rank in [0,1] for each value. Ties get average rank."""
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [0.5]
    s = pd.Series(values).rank(method="average")
    return [float((r - 1) / (n - 1)) for r in s]


def sector_rotation(
    closes: Dict[str, pd.Series],
    *,
    benchmark: str = DEFAULT_BENCHMARK,
    sector_map: Optional[Mapping[str, str]] = None,
    lookbacks: Tuple[int, int, int] = DEFAULT_LOOKBACKS,
    lookback_weights: Tuple[float, float, float] = DEFAULT_LOOKBACK_WEIGHTS,
    slope_weight: float = DEFAULT_SLOPE_WEIGHT,
    breadth_weight: float = DEFAULT_BREADTH_WEIGHT,
    return_weight: float = DEFAULT_RETURN_WEIGHT,
    min_members: int = 1,
) -> RotationReport:
    """Compute per-sector RS scores and rotation recommendations.

    ``closes`` must contain the benchmark ticker. Tickers with unknown sector
    are dropped; tickers with insufficient history are dropped from breadth
    and per-ticker stats but the sector remains as long as ``min_members``
    tickers qualify.
    """
    if benchmark not in closes:
        raise ValueError(f"benchmark {benchmark} not in closes")
    if len(lookbacks) != 3 or len(lookback_weights) != 3:
        raise ValueError("lookbacks and lookback_weights must each have 3 elements")
    if min(lookbacks) <= 0:
        raise ValueError("lookbacks must be positive")
    total_w = sum(lookback_weights) + slope_weight + breadth_weight
    # Caller-controlled, but normalize for percentile rollup
    if total_w <= 0:
        raise ValueError("weights sum must be positive")

    sect_map = dict(DEFAULT_SECTOR_MAP)
    if sector_map:
        for k, v in sector_map.items():
            sect_map[str(k).upper()] = v

    bench_series = closes[benchmark].astype(float).dropna()
    if bench_series.empty:
        raise ValueError("benchmark series empty")

    skipped_unknown: List[str] = []
    skipped_short: List[str] = []
    # Group tickers by sector
    by_sector: Dict[str, List[str]] = {}
    short_window = lookbacks[1]  # 3m window for breadth
    long_window = lookbacks[2]
    for t in closes:
        if t == benchmark:
            continue
        sec = sect_map.get(t.upper())
        if sec is None:
            skipped_unknown.append(t)
            continue
        s = closes[t].dropna()
        if len(s) <= long_window:
            skipped_short.append(t)
            continue
        by_sector.setdefault(sec, []).append(t)

    # Compute raw per-sector aggregates
    rows: List[Dict] = []
    for sector, members in by_sector.items():
        if len(members) < min_members:
            continue
        # equal-weighted sector "index" of normalized prices
        norm = []
        for t in members:
            s = closes[t].astype(float).dropna()
            base = float(s.iloc[0])
            if base <= 0:
                continue
            norm.append(s / base)
        if not norm:
            continue
        sec_idx = pd.concat(norm, axis=1).mean(axis=1)
        sec_idx = sec_idx.dropna()
        if len(sec_idx) <= long_window:
            continue

        r1 = _total_return(sec_idx, lookbacks[0]) or 0.0
        r3 = _total_return(sec_idx, lookbacks[1]) or 0.0
        r6 = _total_return(sec_idx, lookbacks[2]) or 0.0
        slope = _rs_slope(sec_idx, bench_series, lookbacks[1]) or 0.0
        # Breadth: fraction outperforming benchmark over short_window
        bench_r = _total_return(bench_series, short_window) or 0.0
        outperf = 0
        counted = 0
        for t in members:
            s = closes[t].astype(float).dropna()
            tr = _total_return(s, short_window)
            if tr is None:
                continue
            counted += 1
            if tr > bench_r:
                outperf += 1
        breadth = (outperf / counted) if counted else 0.0

        rows.append({
            "sector": sector,
            "members": sorted(members),
            "n_tickers": len(members),
            "ret_1m": r1, "ret_3m": r3, "ret_6m": r6,
            "rs_slope": slope, "breadth": breadth,
        })

    if not rows:
        asof = str(bench_series.index[-1].date()) if hasattr(bench_series.index[-1], "date") else str(bench_series.index[-1])
        return RotationReport(
            benchmark=benchmark, asof=asof,
            overweight=[], underweight=[], scores=[],
            skipped_unknown_sector=sorted(set(skipped_unknown)),
            skipped_short_history=sorted(set(skipped_short)),
        )

    # Percentile-rank each component
    r1_pct = _percentile_ranks([r["ret_1m"] for r in rows])
    r3_pct = _percentile_ranks([r["ret_3m"] for r in rows])
    r6_pct = _percentile_ranks([r["ret_6m"] for r in rows])
    slp_pct = _percentile_ranks([r["rs_slope"] for r in rows])
    brd_pct = _percentile_ranks([r["breadth"] for r in rows])

    rw = list(lookback_weights)
    # Scale returns block to ``return_weight`` of total
    rw_sum = sum(rw) or 1.0
    rw = [w / rw_sum * return_weight for w in rw]
    weights = rw + [slope_weight, breadth_weight]
    w_sum = sum(weights) or 1.0

    scores: List[SectorScore] = []
    composites: List[Tuple[int, float]] = []
    for i, r in enumerate(rows):
        comp = (
            r1_pct[i] * rw[0]
            + r3_pct[i] * rw[1]
            + r6_pct[i] * rw[2]
            + slp_pct[i] * slope_weight
            + brd_pct[i] * breadth_weight
        ) / w_sum
        composites.append((i, comp))
        scores.append(SectorScore(
            sector=r["sector"],
            n_tickers=r["n_tickers"],
            ret_1m=round(r["ret_1m"], 6),
            ret_3m=round(r["ret_3m"], 6),
            ret_6m=round(r["ret_6m"], 6),
            rs_slope=round(r["rs_slope"], 8),
            breadth=round(r["breadth"], 6),
            composite=round(comp, 6),
            call="neutral",
            members=r["members"],
        ))

    # Tertile classification
    composites.sort(key=lambda x: -x[1])
    n = len(composites)
    third = max(1, n // 3)
    over_idx = {i for i, _ in composites[:third]}
    under_idx = {i for i, _ in composites[-third:]}
    overweight: List[str] = []
    underweight: List[str] = []
    for i, sc in enumerate(scores):
        if i in over_idx and i not in under_idx:
            sc.call = "overweight"
            overweight.append(sc.sector)
        elif i in under_idx and i not in over_idx:
            sc.call = "underweight"
            underweight.append(sc.sector)
        else:
            sc.call = "neutral"

    # Order scores by composite descending for readability
    scores.sort(key=lambda s: -s.composite)
    asof = str(bench_series.index[-1].date()) if hasattr(bench_series.index[-1], "date") else str(bench_series.index[-1])
    return RotationReport(
        benchmark=benchmark, asof=asof,
        overweight=overweight, underweight=underweight,
        scores=scores,
        skipped_unknown_sector=sorted(set(skipped_unknown)),
        skipped_short_history=sorted(set(skipped_short)),
    )
