"""Timestamped (v2) webhook signature: verification helper + outbound headers.

The v2 signature binds an explicit timestamp into the HMAC so a receiver
can defend against capture-and-replay even on an idempotent endpoint.
These tests pin both the helper contract (good / bad / stale / tampered)
and the outbound wire format (both headers present, v2 actually verifies
against the body that was sent, replay path reuses the original
timestamp so verification still succeeds when the window is wide).
"""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

from signalclaw.webhooks import (
    DeliveryLogStore,
    PickEvent,
    WebhookStore,
    WebhookSubscription,
    deliver_events,
    replay_delivery,
    verify_signature,
)


def _ev(ticker="AAPL", kind="entered"):
    return PickEvent(
        kind=kind, ticker=ticker, as_of="2024-01-02", prior_as_of="2024-01-01",
        prior_label=None, new_label="watch", prior_score=None, new_score=0.9,
    )


def test_verify_signature_round_trip():
    body = b'{"hello":"world"}'
    ts = str(int(time.time()))
    from signalclaw.webhooks import _sign_v2
    sig = _sign_v2("shh-secret", ts, body)

    assert verify_signature("shh-secret", body, ts, sig) == (True, "ok")


def test_verify_signature_rejects_wrong_secret_and_tampered_body():
    body = b'{"a":1}'
    ts = str(int(time.time()))
    from signalclaw.webhooks import _sign_v2
    sig = _sign_v2("right", ts, body)

    ok, reason = verify_signature("wrong", body, ts, sig)
    assert ok is False and reason == "bad_signature"

    ok, reason = verify_signature("right", b'{"a":2}', ts, sig)
    assert ok is False and reason == "bad_signature"


def test_verify_signature_rejects_stale_timestamp():
    body = b"{}"
    old_ts = str(int(time.time()) - 10_000)
    from signalclaw.webhooks import _sign_v2
    sig = _sign_v2("k", old_ts, body)

    ok, reason = verify_signature("k", body, old_ts, sig, tolerance_s=300)
    assert ok is False and reason == "stale"


def test_verify_signature_input_validation():
    ok, reason = verify_signature("k", b"", None, "v1=deadbeef")
    assert ok is False and reason == "missing_headers"

    ts = str(int(time.time()))
    ok, reason = verify_signature("k", b"x", ts, "v0=zzz")
    assert ok is False and reason == "bad_format"

    ok, reason = verify_signature("k", b"x", "not-an-int", "v1=aa")
    assert ok is False and reason == "bad_timestamp"


def test_deliver_events_emits_v2_headers_and_payload_round_trips(tmp_path: Path):
    sub_store = WebhookStore(tmp_path / "subs.json")
    log_store = DeliveryLogStore(tmp_path / "log.json")
    sub = WebhookSubscription(
        id="sub_1", url="https://example.invalid/hook", secret="topsecret",
        events=list(("entered",)), tickers=[], enabled=True,
    )
    sub_store.add(sub)

    captured = {}

    def fake_http(url, body, headers, timeout):
        captured["url"] = url
        captured["body"] = body
        captured["headers"] = dict(headers)
        return 200, ""

    deliver_events([_ev()], sub_store, http=fake_http, log_store=log_store)

    headers = captured["headers"]
    assert "x-signalclaw-timestamp" in headers
    assert "x-signalclaw-signature-v2" in headers
    assert headers["x-signalclaw-signature-v2"].startswith("v1=")
    # Legacy v1 header is still present for backwards compatibility.
    assert headers["x-signalclaw-signature"].startswith("sha256=")

    # The v2 signature actually verifies against the exact body that was sent.
    ok, reason = verify_signature(
        "topsecret",
        captured["body"],
        headers["x-signalclaw-timestamp"],
        headers["x-signalclaw-signature-v2"],
        tolerance_s=60,
    )
    assert ok, reason

    # And a different secret is rejected (no cross-tenant signature reuse).
    bad, _ = verify_signature(
        "other-tenant-secret",
        captured["body"],
        headers["x-signalclaw-timestamp"],
        headers["x-signalclaw-signature-v2"],
    )
    assert bad is False

    # Replay reuses the original timestamp + v2 signature.
    attempts = log_store.list()
    assert len(attempts) == 1
    original = attempts[0]
    assert original.signature_v2 and original.timestamp

    captured.clear()
    replay_delivery(original.id, sub_store, log_store, http=fake_http)
    assert captured["headers"]["x-signalclaw-timestamp"] == original.timestamp
    assert captured["headers"]["x-signalclaw-signature-v2"] == original.signature_v2
    # Body is byte-identical so the original signature still verifies.
    ok, _ = verify_signature(
        "topsecret",
        captured["body"],
        captured["headers"]["x-signalclaw-timestamp"],
        captured["headers"]["x-signalclaw-signature-v2"],
        tolerance_s=10**9,  # widen window because we are intentionally replaying
    )
    assert ok
