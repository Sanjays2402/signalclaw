"""Webhook delivery log + retry + replay coverage.

Hits the public store + delivery primitives directly so the test is
fast and offline. Verifies:

* transient failures (network) are retried up to ``max_attempts``,
* every attempt is appended to the persisted log,
* status filters narrow results,
* ``replay_delivery`` re-sends the exact signed body and links the
  new attempt to the parent via ``replay_of``.
"""
from __future__ import annotations

import json
from pathlib import Path

from signalclaw.webhooks import (
    DeliveryLogStore,
    PickEvent,
    WebhookStore,
    WebhookSubscription,
    deliver_events,
    replay_delivery,
)


def _calls():
    return {"n": 0, "bodies": []}


def test_retry_logs_and_replays_with_same_body(tmp_path: Path):
    sub_path = tmp_path / "subs.json"
    log_path = tmp_path / "log.json"
    subs = WebhookStore(sub_path)
    log = DeliveryLogStore(log_path)

    sub = WebhookSubscription(
        url="https://example.test/hook",
        events=["entered"],
        tickers=[],
        secret="s3cret",
        enabled=True,
    )
    subs.add(sub)

    # First three attempts return a 502 -> retried; final returns 502 too.
    state = _calls()

    def http(url, body, headers, timeout):
        state["n"] += 1
        state["bodies"].append(body)
        assert headers.get("x-signalclaw-signature", "").startswith("sha256=")
        return 502, "bad gateway"

    events = [PickEvent(kind="entered", ticker="AAPL", as_of="2025-01-02")]
    results = deliver_events(events, subs, http=http,
                             log_store=log, max_attempts=3,
                             sleep=lambda _s: None)
    assert state["n"] == 3, "must retry transient 5xx up to max_attempts"
    # All retries reused the same signed body so HMAC stays valid downstream.
    assert len(set(state["bodies"])) == 1
    assert results[0]["attempts"] == 3
    assert results[0]["status"] == 502

    rows = log.list(limit=10)
    assert len(rows) == 1
    attempt = rows[0]
    assert attempt.status == 502
    assert attempt.attempt == 3
    assert attempt.event_count == 1
    assert attempt.payload_b64, "payload must be stored for replay"

    # Status filter narrows to failed.
    assert log.list(limit=10, status="failed")
    assert not log.list(limit=10, status="ok")

    # Now replay: backend recovered, returns 200.
    state2 = _calls()

    def http_ok(url, body, headers, timeout):
        state2["n"] += 1
        state2["bodies"].append(body)
        # Same body bytes as the original.
        return 200, ""

    replayed = replay_delivery(
        attempt.id, subs, log, http=http_ok,
        max_attempts=2, sleep=lambda _s: None)
    assert replayed is not None
    assert replayed.status == 200
    assert replayed.replay_of == attempt.id
    assert state2["bodies"][0] == state["bodies"][0], \
        "replay must resend the same signed body byte-for-byte"

    # Log now has two attempts; newest first.
    rows = log.list(limit=10)
    assert len(rows) == 2
    assert rows[0].id == replayed.id
    assert log.list(limit=10, status="ok")[0].id == replayed.id


def test_replay_unknown_attempt_returns_none(tmp_path: Path):
    subs = WebhookStore(tmp_path / "s.json")
    log = DeliveryLogStore(tmp_path / "l.json")
    assert replay_delivery("does-not-exist", subs, log,
                           http=lambda *a, **kw: (200, ""),
                           sleep=lambda _s: None) is None
