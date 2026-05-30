

from signalclaw.webhooks import (
    diff_picks, PickEvent, WebhookStore, WebhookSubscription,
    deliver_events, EVENT_KINDS,
)


def _p(ticker, label, score):
    return {"ticker": ticker, "label": label, "score": score,
            "expected_return": 0.0, "rationale": "", "risk_flags": []}


def test_diff_entered_and_exited():
    prior = [_p("AAPL", "watch", 0.8)]
    current = [_p("MSFT", "watch", 0.7)]
    evs = {(e.kind, e.ticker) for e in diff_picks(current, prior, "2024-01-02", "2024-01-01")}
    assert ("entered", "MSFT") in evs
    assert ("exited", "AAPL") in evs


def test_diff_upgraded_downgraded():
    prior = [_p("AAPL", "hold", 0.5), _p("MSFT", "watch", 0.9)]
    current = [_p("AAPL", "watch", 0.6), _p("MSFT", "hold", 0.4)]
    events = diff_picks(current, prior, "2024-01-02", "2024-01-01")
    kinds = {(e.kind, e.ticker): e for e in events}
    assert kinds[("upgraded", "AAPL")].new_label == "watch"
    assert kinds[("downgraded", "MSFT")].new_label == "hold"


def test_diff_score_jump_only_when_label_unchanged():
    prior = [_p("AAPL", "watch", 0.50)]
    current = [_p("AAPL", "watch", 0.80)]   # +0.30 delta
    events = diff_picks(current, prior, "x", "y", score_jump_threshold=0.15)
    assert any(e.kind == "score_jump" and e.ticker == "AAPL" for e in events)


def test_diff_no_event_for_small_score_change():
    prior = [_p("AAPL", "watch", 0.50)]
    current = [_p("AAPL", "watch", 0.55)]
    events = diff_picks(current, prior, "x", "y", score_jump_threshold=0.15)
    assert events == []


def test_diff_with_no_prior_emits_all_entered():
    current = [_p("AAPL", "watch", 0.7), _p("MSFT", "hold", 0.4)]
    events = diff_picks(current, None, "2024-01-01")
    assert all(e.kind == "entered" for e in events)
    assert {e.ticker for e in events} == {"AAPL", "MSFT"}


def test_subscription_matches_filters():
    sub = WebhookSubscription(url="http://x", events=["entered"],
                              tickers=["AAPL"])
    assert sub.matches(PickEvent(kind="entered", ticker="AAPL", as_of="x"))
    assert not sub.matches(PickEvent(kind="entered", ticker="MSFT", as_of="x"))
    assert not sub.matches(PickEvent(kind="exited", ticker="AAPL", as_of="x"))


def test_subscription_disabled_blocks():
    sub = WebhookSubscription(url="http://x", enabled=False)
    assert not sub.matches(PickEvent(kind="entered", ticker="AAPL", as_of="x"))


def test_subscription_default_events_includes_all_kinds():
    sub = WebhookSubscription(url="http://x")
    for k in EVENT_KINDS:
        assert sub.matches(PickEvent(kind=k, ticker="AAPL", as_of="x"))


def test_store_add_list_remove(tmp_path):
    store = WebhookStore(tmp_path / "wh.json")
    sub = WebhookSubscription(url="https://example.test/hook")
    store.add(sub)
    assert len(store.list()) == 1
    assert store.list()[0].url == "https://example.test/hook"
    assert store.remove(sub.id)
    assert store.list() == []
    assert not store.remove("missing")


def test_deliver_events_calls_http_and_signs(tmp_path):
    store = WebhookStore(tmp_path / "wh.json")
    sub_a = WebhookSubscription(url="https://a.test/hook",
                                 tickers=["AAPL"], secret="s3cret")
    sub_b = WebhookSubscription(url="https://b.test/hook",
                                 events=["entered"])
    sub_c = WebhookSubscription(url="https://c.test/hook",
                                 tickers=["MSFT"])  # no match
    store.add(sub_a); store.add(sub_b); store.add(sub_c)

    events = [
        PickEvent(kind="entered", ticker="AAPL", as_of="2024-01-01"),
        PickEvent(kind="upgraded", ticker="AAPL", as_of="2024-01-01"),
    ]
    calls = []

    def fake_http(url, body, headers, timeout):
        calls.append((url, body, dict(headers)))
        return 200, ""

    results = deliver_events(events, store, http=fake_http)
    urls = {r["url"] for r in results}
    assert "https://a.test/hook" in urls
    assert "https://b.test/hook" in urls
    assert "https://c.test/hook" not in urls

    # signed delivery uses sha256= prefix
    sig_call = next(c for c in calls if c[0] == "https://a.test/hook")
    assert "x-signalclaw-signature" in sig_call[2]
    assert sig_call[2]["x-signalclaw-signature"].startswith("sha256=")

    # state recorded
    reloaded = {s.id: s for s in store.list()}
    assert reloaded[sub_a.id].last_status == 200
    assert reloaded[sub_a.id].last_delivered_at is not None


def test_deliver_handles_http_failure(tmp_path):
    store = WebhookStore(tmp_path / "wh.json")
    sub = WebhookSubscription(url="https://x.test/hook")
    store.add(sub)
    def boom(url, body, headers, timeout):
        return 0, "connection refused"
    results = deliver_events([PickEvent(kind="entered", ticker="AAPL", as_of="x")],
                              store, http=boom)
    assert results and results[0]["status"] == 0
    assert "refused" in results[0]["error"]
    assert store.list()[0].last_error == "connection refused"


def test_deliver_with_no_events_short_circuits(tmp_path):
    store = WebhookStore(tmp_path / "wh.json")
    store.add(WebhookSubscription(url="https://x.test/hook"))
    called = []
    def http(*a, **k):
        called.append(a)
        return 200, ""
    assert deliver_events([], store, http=http) == []
    assert called == []
