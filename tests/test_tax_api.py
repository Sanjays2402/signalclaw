from __future__ import annotations
import os
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app

HEAD = {"x-api-key": "test-key"}


def _add(c, **kw):
    body = {"ticker": "TAXT", "side": "buy", "quantity": 10, "price": 100,
            "date": "2024-01-01", "fees": 0.0, "note": ""}
    body.update(kw)
    r = c.post("/portfolio/trades", headers=HEAD, json=body)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_tax_endpoint_fifo_vs_lifo():
    c = TestClient(app)
    _add(c, side="buy", quantity=10, price=100, date="2024-01-01")
    _add(c, side="buy", quantity=10, price=120, date="2024-02-01")
    _add(c, side="sell", quantity=15, price=130, date="2024-03-01")

    rf = c.get("/portfolio/tax?method=fifo", headers=HEAD)
    assert rf.status_code == 200
    fifo_total = rf.json()["realized_total"]

    rl = c.get("/portfolio/tax?method=lifo", headers=HEAD)
    assert rl.status_code == 200
    lifo_total = rl.json()["realized_total"]

    assert fifo_total != lifo_total
    # FIFO should produce higher gain in an up-trending lot sequence
    assert fifo_total > lifo_total

    # cleanup
    for t in c.get("/portfolio/trades", headers=HEAD).json()["trades"]:
        c.delete(f"/portfolio/trades/{t['id']}", headers=HEAD)


def test_tax_endpoint_rejects_unknown_method():
    c = TestClient(app)
    r = c.get("/portfolio/tax?method=bogus", headers=HEAD)
    assert r.status_code == 400


def test_tax_endpoint_requires_key():
    c = TestClient(app)
    assert c.get("/portfolio/tax").status_code in (401, 403)
