from __future__ import annotations
import os
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
import sys
import importlib
from fastapi.testclient import TestClient

importlib.import_module("signalclaw.api.app")
app_mod = sys.modules["signalclaw.api.app"]
create_app = app_mod.create_app
H = {"x-api-key": "test-key"}


def _client(tmp_path):
    s = app_mod.get_settings()
    s.data_dir = tmp_path
    return TestClient(create_app())


import pytest


@pytest.fixture(autouse=True)
def _restore_data_dir():
    s = app_mod.get_settings()
    orig = s.data_dir
    yield
    s.data_dir = orig


def test_earnings_crud(tmp_path):
    c = _client(tmp_path)
    # Empty list
    r = c.get("/earnings", headers=H)
    assert r.status_code == 200
    assert r.json()["rows"] == []
    # Upsert
    r = c.put("/earnings/MSFT", json={"next_report": "2026-07-23", "confirmed": True}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["ticker"] == "MSFT"
    # Invalid date
    r = c.put("/earnings/TSLA", json={"next_report": "not-a-date"}, headers=H)
    assert r.status_code == 400
    # List
    r = c.get("/earnings", headers=H)
    assert len(r.json()["rows"]) == 1
    # Filter upcoming
    r = c.get("/earnings?within_days=1", headers=H)
    assert r.status_code == 200
    # Delete
    r = c.delete("/earnings/MSFT", headers=H)
    assert r.status_code == 200
    r = c.delete("/earnings/MSFT", headers=H)
    assert r.status_code == 404
