from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def test_correlation_endpoint_requires_key():
    c = TestClient(app)
    assert c.get("/correlation").status_code in (401, 403)


def test_diversification_endpoint_requires_key():
    c = TestClient(app)
    assert c.get("/diversification").status_code in (401, 403)


def test_correlation_endpoint_returns_structure():
    c = TestClient(app)
    # offline, no parquet usually means empty matrix; either way the schema holds
    r = c.get("/correlation?window=30&tickers=AAA,BBB", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    assert "tickers" in body and "matrix" in body and "window" in body
    assert body["window"] == 30


def test_diversification_endpoint_returns_structure():
    c = TestClient(app)
    r = c.get("/diversification", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    for k in ("window", "threshold", "n_tickers", "avg_pairwise_corr",
              "max_pairwise_corr", "clusters", "warnings"):
        assert k in body, k
