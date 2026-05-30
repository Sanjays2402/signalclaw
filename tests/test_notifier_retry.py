"""Tests for notifier retry, dead-letter queue, and Slack notifier."""
from __future__ import annotations
from pathlib import Path
from typing import List, Optional

import pytest

from signalclaw.notifier import (
    DeadLetter,
    DeadLetterQueue,
    Notifier,
    RetryPolicy,
    SlackNotifier,
    replay_dlq,
    send_with_retry,
)


class _FlakyNotifier(Notifier):
    def __init__(self, results: List[object]):
        # results may contain True/False or Exception instances
        self.results = list(results)
        self.sent: List[str] = []

    def send(self, text: str) -> bool:
        self.sent.append(text)
        if not self.results:
            return True
        r = self.results.pop(0)
        if isinstance(r, BaseException):
            raise r
        return bool(r)


def test_retry_policy_validates() -> None:
    with pytest.raises(ValueError):
        RetryPolicy(max_attempts=0)
    with pytest.raises(ValueError):
        RetryPolicy(initial_delay=-1)
    with pytest.raises(ValueError):
        RetryPolicy(backoff=0.5)
    with pytest.raises(ValueError):
        RetryPolicy(jitter=1.5)


def test_retry_policy_delay_for_grows_and_caps() -> None:
    p = RetryPolicy(max_attempts=5, initial_delay=1.0, max_delay=4.0,
                     backoff=2.0, jitter=0.0)
    assert p.delay_for(1) == 0.0
    assert p.delay_for(2) == pytest.approx(1.0)
    assert p.delay_for(3) == pytest.approx(2.0)
    assert p.delay_for(4) == pytest.approx(4.0)
    assert p.delay_for(5) == pytest.approx(4.0)  # capped


def test_send_with_retry_success_on_first_attempt() -> None:
    n = _FlakyNotifier([True])
    slept: List[float] = []
    ok = send_with_retry(n, "hi", channel="x",
                          policy=RetryPolicy(max_attempts=3, initial_delay=0.01),
                          sleep=slept.append)
    assert ok is True
    assert len(n.sent) == 1
    assert slept == [0.0] or slept == []  # delay_for(1) == 0


def test_send_with_retry_eventually_succeeds() -> None:
    n = _FlakyNotifier([False, False, True])
    slept: List[float] = []
    ok = send_with_retry(n, "hi", channel="x",
                          policy=RetryPolicy(max_attempts=3, initial_delay=0.01,
                                              jitter=0.0),
                          sleep=slept.append)
    assert ok is True
    assert len(n.sent) == 3


def test_send_with_retry_exhausts_and_enqueues_dlq(tmp_path: Path) -> None:
    dlq = DeadLetterQueue(tmp_path / "dlq.json")
    n = _FlakyNotifier([False, False, False])
    ok = send_with_retry(n, "msg", channel="slack",
                          policy=RetryPolicy(max_attempts=3, initial_delay=0,
                                              jitter=0.0),
                          dlq=dlq, sleep=lambda _: None)
    assert ok is False
    items = dlq.list()
    assert len(items) == 1
    assert items[0].channel == "slack"
    assert items[0].text == "msg"
    assert items[0].attempts == 3
    assert "send returned False" in items[0].last_error


def test_send_with_retry_captures_exception_in_dlq(tmp_path: Path) -> None:
    dlq = DeadLetterQueue(tmp_path / "dlq.json")
    n = _FlakyNotifier([RuntimeError("boom"), RuntimeError("boom2")])
    ok = send_with_retry(n, "msg", channel="slack",
                          policy=RetryPolicy(max_attempts=2, initial_delay=0,
                                              jitter=0.0),
                          dlq=dlq, sleep=lambda _: None)
    assert ok is False
    items = dlq.list()
    assert len(items) == 1
    assert "RuntimeError" in items[0].last_error


def test_dead_letter_queue_filter_remove_clear(tmp_path: Path) -> None:
    dlq = DeadLetterQueue(tmp_path / "dlq.json")
    a = dlq.enqueue(DeadLetter(id="a", channel="slack", text="x",
                                attempts=1, last_error="", enqueued_at="t"))
    dlq.enqueue(DeadLetter(id="b", channel="telegram", text="y",
                            attempts=1, last_error="", enqueued_at="t"))
    assert len(dlq.list()) == 2
    assert len(dlq.list(channel="slack")) == 1
    assert dlq.remove("a") is True
    assert dlq.remove("a") is False
    dlq.clear()
    assert dlq.list() == []


def test_replay_dlq_sends_successes_and_keeps_failures(tmp_path: Path) -> None:
    dlq = DeadLetterQueue(tmp_path / "dlq.json")
    dlq.enqueue(DeadLetter(id="i1", channel="slack", text="ok",
                            attempts=1, last_error="", enqueued_at="t"))
    dlq.enqueue(DeadLetter(id="i2", channel="slack", text="bad",
                            attempts=1, last_error="", enqueued_at="t"))
    dlq.enqueue(DeadLetter(id="i3", channel="discord", text="z",
                            attempts=1, last_error="", enqueued_at="t"))

    good = _FlakyNotifier([True])
    bad = _FlakyNotifier([False])

    seen: List[str] = []

    def factory(channel: str) -> Optional[Notifier]:
        seen.append(channel)
        if channel == "slack":
            # First call -> good (id=i1), second -> bad (id=i2)
            return good if good.results or not bad.results else bad
        return None  # no discord notifier configured

    # Easier: route by text since channels are the same
    class _Router(Notifier):
        def send(self, text: str) -> bool:
            return text == "ok"

    counts = replay_dlq(dlq,
                         lambda ch: _Router() if ch == "slack" else None,
                         policy=RetryPolicy(max_attempts=1, initial_delay=0,
                                              jitter=0.0),
                         sleep=lambda _: None)
    assert counts == {"sent": 1, "kept": 1, "skipped": 1}
    remaining = {i.id for i in dlq.list()}
    assert "i1" not in remaining  # success removed
    assert "i2" in remaining       # failure kept
    assert "i3" in remaining       # skipped kept


def test_slack_notifier_dry_run_when_url_blank(monkeypatch) -> None:
    monkeypatch.setenv("SLACK_WEBHOOK_URL", "")
    from signalclaw.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    n = SlackNotifier()
    assert n.send("hello") is False
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_slack_notifier_posts_payload(monkeypatch) -> None:
    captured = {}

    class _FakeResponse:
        def raise_for_status(self):
            return None

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return _FakeResponse()

    import signalclaw.notifier.slack as slack_mod
    monkeypatch.setattr(slack_mod.httpx, "post", fake_post)
    n = SlackNotifier(webhook_url="https://hooks.slack.test/abc",
                      channel="#alerts")
    assert n.send("hi") is True
    assert captured["url"] == "https://hooks.slack.test/abc"
    assert captured["json"]["text"] == "hi"
    assert captured["json"]["channel"] == "#alerts"


def test_slack_notifier_returns_false_on_http_error(monkeypatch) -> None:
    def fake_post(*a, **kw):
        raise RuntimeError("boom")

    import signalclaw.notifier.slack as slack_mod
    monkeypatch.setattr(slack_mod.httpx, "post", fake_post)
    n = SlackNotifier(webhook_url="https://hooks.slack.test/x")
    assert n.send("hi") is False
