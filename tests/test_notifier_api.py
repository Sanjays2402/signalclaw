"""API tests for notifier dead-letter queue and test endpoint."""
from __future__ import annotations
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
HEAD = {"x-api-key": "test-key"}


@pytest.fixture()
def isolated_app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "")  # dry-run, send returns False
    monkeypatch.setenv("TELEGRAM_ENABLED", "false")
    from signalclaw.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    from signalclaw.api import create_app
    app = create_app()
    yield TestClient(app)
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_notifier_test_unknown_channel(isolated_app):
    r = isolated_app.post("/notifier/test", headers=HEAD, json={
        "channel": "bogus", "text": "hi",
    })
    assert r.status_code == 400


def test_notifier_test_dry_run_enqueues_dlq(isolated_app):
    # Slack dry-run returns False -> after retries, item enqueued
    r = isolated_app.post("/notifier/test", headers=HEAD, json={
        "channel": "slack", "text": "hi",
    })
    assert r.status_code == 200
    assert r.json()["ok"] is False

    r = isolated_app.get("/notifier/dlq", headers=HEAD)
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["channel"] == "slack"


def test_notifier_dlq_filter_and_remove(isolated_app):
    isolated_app.post("/notifier/test", headers=HEAD,
                       json={"channel": "slack", "text": "a"})
    isolated_app.post("/notifier/test", headers=HEAD,
                       json={"channel": "discord", "text": "b"})
    r = isolated_app.get("/notifier/dlq", headers=HEAD,
                          params={"channel": "slack"})
    assert len(r.json()["items"]) == 1
    item_id = r.json()["items"][0]["id"]
    r = isolated_app.delete(f"/notifier/dlq/{item_id}", headers=HEAD)
    assert r.status_code == 200
    r = isolated_app.delete(f"/notifier/dlq/{item_id}", headers=HEAD)
    assert r.status_code == 404


def test_notifier_dlq_replay_still_fails_in_dry_run(isolated_app):
    isolated_app.post("/notifier/test", headers=HEAD,
                       json={"channel": "slack", "text": "x"})
    r = isolated_app.post("/notifier/dlq/replay", headers=HEAD)
    assert r.status_code == 200
    body = r.json()
    # All notifiers dry-run -> kept (replay tried, still failed)
    assert body["kept"] >= 1
    assert body["sent"] == 0
