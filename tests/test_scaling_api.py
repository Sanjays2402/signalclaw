from __future__ import annotations
from fastapi.testclient import TestClient
from signalclaw.api.app import create_app


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k")
    monkeypatch.setenv("SIGNALCLAW_DATA_DIR", str(tmp_path))
    from signalclaw.config import get_settings
    get_settings.cache_clear()
    return TestClient(create_app()), {"x-api-key": "k"}


def _plan_body():
    return {
        "ticker": "AAA",
        "entry": 100.0, "initial_stop": 95.0, "initial_shares": 100,
        "rungs": [
            {"r_multiple": 1.0, "action": "add",
             "size_fraction": 0.5, "new_stop_r": 0.0},
            {"r_multiple": 2.0, "action": "trim",
             "size_fraction": 0.25, "new_stop_r": 1.0},
        ],
    }


def test_create_list_and_delete_scaling_plan(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/scaling/plans", headers=h, json=_plan_body())
    assert r.status_code == 200, r.text
    plan_id = r.json()["plan_id"]
    r = client.get("/scaling/plans", headers=h)
    assert r.status_code == 200
    assert any(p["plan_id"] == plan_id for p in r.json()["plans"])
    r = client.delete(f"/scaling/plans/{plan_id}", headers=h)
    assert r.status_code == 200
    r = client.delete(f"/scaling/plans/{plan_id}", headers=h)
    assert r.status_code == 404


def test_evaluate_endpoint_triggers_rungs(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/scaling/plans", headers=h, json=_plan_body())
    plan_id = r.json()["plan_id"]
    r = client.post(f"/scaling/plans/{plan_id}/evaluate", headers=h, json={
        "bars": [
            {"index": 0, "high": 104.0, "low": 100.0},
            {"index": 1, "high": 106.0, "low": 102.0},
            {"index": 2, "high": 111.0, "low": 105.0},
        ],
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert [e["rung_index"] for e in d["events"]] == [0, 1]
    assert d["events"][0]["action"] == "add"
    assert d["events"][0]["shares"] == 50
    assert d["events"][1]["action"] == "trim"
    assert d["events"][1]["shares"] == -25
    assert d["plan"]["status"] == "done"


def test_evaluate_endpoint_404_when_plan_missing(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/scaling/plans/nope/evaluate", headers=h,
                    json={"bars": []})
    assert r.status_code == 404


def test_cancel_endpoint_marks_plan_cancelled(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/scaling/plans", headers=h, json=_plan_body())
    plan_id = r.json()["plan_id"]
    r = client.post(f"/scaling/plans/{plan_id}/cancel", headers=h)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


def test_create_endpoint_rejects_invalid_rungs(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    body = _plan_body()
    body["rungs"][0]["r_multiple"] = -1.0
    r = client.post("/scaling/plans", headers=h, json=body)
    assert r.status_code == 400


def test_evaluate_rejects_bad_bar(monkeypatch, tmp_path):
    client, h = _client(monkeypatch, tmp_path)
    r = client.post("/scaling/plans", headers=h, json=_plan_body())
    plan_id = r.json()["plan_id"]
    r = client.post(f"/scaling/plans/{plan_id}/evaluate", headers=h,
                    json={"bars": [{"index": 0, "high": 5, "low": 10}]})
    assert r.status_code == 400


def test_scaling_requires_api_key(monkeypatch, tmp_path):
    client, _ = _client(monkeypatch, tmp_path)
    r = client.get("/scaling/plans")
    assert r.status_code in (401, 403)
