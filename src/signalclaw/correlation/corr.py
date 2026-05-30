"""Correlation matrix and diversification warnings.

Pure functions over a {ticker -> close-price Series} dict so callers can
build matrices from any source (parquet cache, fresh fetch, synthetic data
in tests).
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


def _close_panel(closes: Dict[str, pd.Series], min_overlap: int = 30) -> pd.DataFrame:
    """Align close-price series on common dates. Drops tickers with too little overlap."""
    if not closes:
        return pd.DataFrame()
    panel = pd.DataFrame({t: s.astype(float) for t, s in closes.items()})
    panel = panel.dropna(how="all")
    # Require each column to have at least min_overlap finite values jointly
    common = panel.dropna()
    if len(common) < min_overlap:
        # Fall back to forward-fill within each column then drop
        panel = panel.ffill().dropna()
    else:
        panel = common
    return panel


def _returns(panel: pd.DataFrame) -> pd.DataFrame:
    return np.log(panel).diff().dropna(how="all")


def correlation_matrix(
    closes: Dict[str, pd.Series],
    window: Optional[int] = None,
    min_overlap: int = 30,
) -> pd.DataFrame:
    """Pearson correlation of log returns. If window given, uses only the last N rows."""
    panel = _close_panel(closes, min_overlap=min_overlap)
    if panel.empty or panel.shape[1] < 2:
        return pd.DataFrame()
    rets = _returns(panel)
    if window is not None and window > 0:
        rets = rets.tail(window)
    return rets.corr().round(6)


def rolling_correlation_matrix(
    closes: Dict[str, pd.Series],
    window: int = 60,
    min_overlap: int = 30,
) -> Dict[str, pd.DataFrame]:
    """Latest correlation matrices over multiple windows for stability inspection."""
    out: Dict[str, pd.DataFrame] = {}
    for w in (window // 2 or 1, window, window * 2):
        m = correlation_matrix(closes, window=w, min_overlap=min_overlap)
        if not m.empty:
            out[f"w{w}"] = m
    return out


def cluster_by_correlation(
    corr: pd.DataFrame,
    threshold: float = 0.70,
) -> List[List[str]]:
    """Group tickers via single-linkage on correlation >= threshold.

    Returns clusters sorted by size desc then ticker. Solo tickers form
    their own one-element cluster.
    """
    if corr.empty:
        return []
    tickers = list(corr.index)
    parent: Dict[str, str] = {t: t for t in tickers}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i, a in enumerate(tickers):
        for b in tickers[i + 1:]:
            v = corr.loc[a, b]
            if pd.notna(v) and abs(v) >= threshold:
                union(a, b)

    clusters: Dict[str, List[str]] = {}
    for t in tickers:
        clusters.setdefault(find(t), []).append(t)
    out = [sorted(grp) for grp in clusters.values()]
    out.sort(key=lambda g: (-len(g), g[0]))
    return out


@dataclass
class DiversificationReport:
    window: int
    threshold: float
    n_tickers: int
    avg_pairwise_corr: float
    max_pairwise_corr: float
    most_correlated_pair: Optional[Tuple[str, str]]
    clusters: List[List[str]]
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["most_correlated_pair"] = (list(self.most_correlated_pair)
                                     if self.most_correlated_pair else None)
        return d


def diversification_warnings(
    closes: Dict[str, pd.Series],
    weights: Optional[Dict[str, float]] = None,
    window: int = 60,
    cluster_threshold: float = 0.70,
    avg_corr_warn: float = 0.60,
    concentration_warn: float = 0.40,
) -> DiversificationReport:
    """Build a diversification report.

    Warnings cover:
      - average pairwise correlation above avg_corr_warn
      - any cluster (>= 2 tickers) whose combined weight exceeds concentration_warn
      - single-name weight above concentration_warn
    """
    corr = correlation_matrix(closes, window=window)
    if corr.empty:
        return DiversificationReport(
            window=window,
            threshold=cluster_threshold,
            n_tickers=len(closes),
            avg_pairwise_corr=0.0,
            max_pairwise_corr=0.0,
            most_correlated_pair=None,
            clusters=[],
            warnings=["insufficient data"],
        )
    # Average / max pairwise corr (off-diagonal upper triangle)
    arr = corr.values
    n = arr.shape[0]
    iu = np.triu_indices(n, k=1)
    pair_vals = arr[iu]
    avg_corr = float(np.nanmean(pair_vals)) if pair_vals.size else 0.0
    max_corr = float(np.nanmax(pair_vals)) if pair_vals.size else 0.0
    pair: Optional[Tuple[str, str]] = None
    if pair_vals.size:
        flat_idx = int(np.nanargmax(pair_vals))
        i, j = iu[0][flat_idx], iu[1][flat_idx]
        pair = (corr.index[i], corr.columns[j])

    clusters = cluster_by_correlation(corr, threshold=cluster_threshold)

    warnings: List[str] = []
    if avg_corr >= avg_corr_warn:
        warnings.append(
            f"average pairwise correlation {avg_corr:.2f} >= {avg_corr_warn:.2f}"
        )
    if weights:
        for t, w in weights.items():
            if w >= concentration_warn:
                warnings.append(f"single-name concentration {t}={w:.0%}")
        for grp in clusters:
            if len(grp) < 2:
                continue
            gw = sum(weights.get(t, 0.0) for t in grp)
            if gw >= concentration_warn:
                warnings.append(
                    f"cluster {grp} combined weight {gw:.0%}"
                )

    return DiversificationReport(
        window=window,
        threshold=cluster_threshold,
        n_tickers=len(corr.index),
        avg_pairwise_corr=avg_corr,
        max_pairwise_corr=max_corr,
        most_correlated_pair=pair,
        clusters=clusters,
        warnings=warnings,
    )
