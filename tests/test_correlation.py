from __future__ import annotations
import numpy as np
import pandas as pd
import pytest

from signalclaw.correlation import (
    correlation_matrix,
    rolling_correlation_matrix,
    cluster_by_correlation,
    diversification_warnings,
)


def _series(values, start="2026-01-01"):
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="D"))


def _from_returns(rets, start_price=100.0, start="2026-01-01"):
    prices = start_price * np.exp(np.cumsum(rets))
    return _series(prices, start=start)


def test_correlation_matrix_perfect_positive():
    base = np.linspace(100, 200, 200)
    closes = {"A": _series(base), "B": _series(base * 2.0)}
    m = correlation_matrix(closes)
    assert m.loc["A", "B"] == pytest.approx(1.0, abs=1e-6)


def test_correlation_matrix_perfect_negative():
    rng = np.random.default_rng(0)
    rets = rng.normal(0, 0.01, 250)
    a = 100 * np.exp(np.cumsum(rets))
    b = 100 * np.exp(np.cumsum(-rets))
    m = correlation_matrix({"A": _series(a), "B": _series(b)})
    assert m.loc["A", "B"] == pytest.approx(-1.0, abs=1e-6)


def test_correlation_matrix_empty():
    assert correlation_matrix({}).empty
    s = _series(list(range(50)))
    assert correlation_matrix({"only": s}).empty


def test_correlation_matrix_respects_window():
    rng = np.random.default_rng(1)
    rets_a = rng.normal(0, 0.01, 500)
    rets_b = rng.normal(0, 0.01, 500)
    # last 30 days correlated, prior uncorrelated
    rets_b[-30:] = rets_a[-30:]
    a = 100 * np.exp(np.cumsum(rets_a))
    b = 100 * np.exp(np.cumsum(rets_b))
    m_long = correlation_matrix({"A": _series(a), "B": _series(b)})
    m_short = correlation_matrix({"A": _series(a), "B": _series(b)}, window=30)
    assert m_short.loc["A", "B"] > m_long.loc["A", "B"]
    assert m_short.loc["A", "B"] > 0.9


def test_cluster_by_correlation_groups_correlated():
    rng = np.random.default_rng(2)
    shared = rng.normal(0, 0.01, 300)
    closes = {
        "A": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "B": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "C": _from_returns(rng.normal(0, 0.01, 300)),
    }
    m = correlation_matrix(closes)
    clusters = cluster_by_correlation(m, threshold=0.70)
    joined = sorted(["A", "B"])
    found = any(sorted(g) == joined for g in clusters)
    assert found, (clusters, m)


def test_cluster_each_singleton_when_threshold_high():
    rng = np.random.default_rng(3)
    closes = {f"T{i}": _from_returns(rng.normal(0, 0.01, 300)) for i in range(4)}
    m = correlation_matrix(closes)
    clusters = cluster_by_correlation(m, threshold=0.999)
    assert sum(len(g) for g in clusters) == 4
    assert all(len(g) == 1 for g in clusters)


def test_rolling_correlation_matrix_keys():
    rng = np.random.default_rng(4)
    out = rolling_correlation_matrix(
        {"A": _from_returns(rng.normal(0, 0.01, 400)),
         "B": _from_returns(rng.normal(0, 0.01, 400))}, window=60)
    assert "w60" in out and "w120" in out


def test_diversification_warnings_high_avg_corr():
    rng = np.random.default_rng(5)
    shared = rng.normal(0, 0.01, 300)
    closes = {
        "A": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "B": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "C": _from_returns(shared + rng.normal(0, 0.001, 300)),
    }
    rep = diversification_warnings(closes, weights={"A": 0.4, "B": 0.4, "C": 0.2})
    assert rep.avg_pairwise_corr > 0.5
    assert any("correlation" in w for w in rep.warnings)
    # All three should be in the same cluster
    assert len(rep.clusters) == 1
    assert sorted(rep.clusters[0]) == ["A", "B", "C"]


def test_diversification_warns_on_single_name_concentration():
    rng = np.random.default_rng(6)
    closes = {
        "A": _from_returns(rng.normal(0, 0.01, 300)),
        "B": _from_returns(rng.normal(0, 0.01, 300)),
    }
    rep = diversification_warnings(closes, weights={"A": 0.55, "B": 0.45},
                                   concentration_warn=0.40)
    assert any("A=55%" in w or "A=55" in w for w in rep.warnings)


def test_diversification_warns_on_cluster_concentration():
    rng = np.random.default_rng(7)
    shared = rng.normal(0, 0.01, 300)
    closes = {
        "A": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "B": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "C": _from_returns(rng.normal(0, 0.01, 300)),
    }
    rep = diversification_warnings(
        closes,
        weights={"A": 0.30, "B": 0.30, "C": 0.40},
        cluster_threshold=0.70,
        concentration_warn=0.50,
    )
    cluster_warning = [w for w in rep.warnings if "cluster" in w]
    assert cluster_warning, rep.warnings


def test_diversification_no_data_returns_safe_report():
    rep = diversification_warnings({})
    assert rep.n_tickers == 0
    assert "insufficient data" in rep.warnings


def test_diversification_most_correlated_pair_identified():
    rng = np.random.default_rng(8)
    shared = rng.normal(0, 0.01, 300)
    closes = {
        "A": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "B": _from_returns(shared + rng.normal(0, 0.001, 300)),
        "C": _from_returns(rng.normal(0, 0.01, 300)),
    }
    rep = diversification_warnings(closes)
    assert rep.most_correlated_pair is not None
    assert set(rep.most_correlated_pair) == {"A", "B"}
