from __future__ import annotations
import os
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import sys
import importlib
import pandas as pd
from fastapi.testclient import TestClient

importlib.import_module("signalclaw.api.app")
app_mod = sys.modules["signalclaw.api.app"]
create_app = app_mod.create_app

H = {"x-api-key": "test-key"}


def _client(tmp_path, monkeypatch):
    s = app_mod.get_settings()
    s.data_dir = tmp_path
    return TestClient(create_app())


def test_stops_crud_and_check(tmp_path, monkeypatch):
    df = pd.DataFrame({"close": [100.0, 105.0, 95.0]},
                       index=pd.date_range("2024-01-01", periods=3))
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: df if t.upper() == "MSFT" else pd.DataFrame())
    c = _client(tmp_path, monkeypatch)

    # Add stop_loss at 100 → should fire on last close (95)
    r = c.post("/stops", json={"ticker": "MSFT", "kind": "stop_loss", "value": 100.0}, headers=H)
    assert r.status_code == 200, r.text
    rule_id = r.json()["id"]

    r = c.get("/stops", headers=H)
    assert r.status_code == 200
    assert len(r.json()["rules"]) == 1

    r = c.post("/stops/check", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["checked"] == 1
    assert len(body["events"]) == 1
    assert body["events"][0]["kind"] == "stop_loss"

    r = c.delete(f"/stops/{rule_id}", headers=H)
    assert r.status_code == 200
    r = c.delete(f"/stops/{rule_id}", headers=H)
    assert r.status_code == 404


def test_stops_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(app_mod, "load_ohlcv", lambda t: pd.DataFrame())
    c = _client(tmp_path, monkeypatch)

    r = c.post("/stops", json={"ticker": "X", "kind": "weird", "value": 1.0}, headers=H)
    assert r.status_code == 400
    r = c.post("/stops", json={"ticker": "X", "kind": "trailing", "value": 1.5}, headers=H)
    assert r.status_code == 400
    r = c.post("/stops", json={"ticker": "X", "kind": "stop_loss", "value": -1}, headers=H)
    assert r.status_code == 400
