from __future__ import annotations
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pytest

from signalclaw.alerts import (
    Alert,
    AlertCondition,
    AlertStore,
    evaluate_alerts,
    dispatch_hits,
)
from signalclaw.alerts.rules import AlertHit


def _df(prices):
    idx = pd.date_range("2026-01-01", periods=len(prices), freq="D")
    return pd.DataFrame({"open": prices, "high": prices, "low": prices,
                         "close": prices, "volume": [1000] * len(prices)}, index=idx)


def test_alert_roundtrip_dict():
    a = Alert(ticker="msft", condition=AlertCondition.PRICE_ABOVE, value=400.0)
    d = a.to_dict()
    a2 = Alert.from_dict(d)
    assert a2.ticker == "MSFT"
    assert a2.condition == AlertCondition.PRICE_ABOVE
    assert a2.value == 400.0
    assert a2.id == a.id


def test_alert_store_crud(tmp_path: Path):
    store = AlertStore(tmp_path / "a.json")
    assert store.list() == []
    a = Alert(ticker="SPY", condition=AlertCondition.PRICE_BELOW, value=500)
    store.add(a)
    assert len(store.list()) == 1
    assert store.list(ticker="spy")[0].id == a.id
    assert store.list(ticker="msft") == []
    assert store.get(a.id) is not None
    assert store.remove(a.id) is True
    assert store.remove("does-not-exist") is False


def test_price_above_triggers():
    a = Alert(ticker="MSFT", condition=AlertCondition.PRICE_ABOVE, value=100.0)
    hits = evaluate_alerts([a], {"MSFT": _df([90, 95, 105])})
    assert len(hits) == 1
    assert hits[0].ticker == "MSFT"
    assert float(hits[0].observed) == 105.0


def test_price_below_no_trigger():
    a = Alert(ticker="MSFT", condition=AlertCondition.PRICE_BELOW, value=50.0)
    hits = evaluate_alerts([a], {"MSFT": _df([90, 95, 105])})
    assert hits == []


def test_pct_change_above():
    a = Alert(ticker="X", condition=AlertCondition.PCT_CHANGE_ABOVE, value=0.05)
    hits = evaluate_alerts([a], {"X": _df([100, 110])})
    assert len(hits) == 1


def test_pct_change_below():
    a = Alert(ticker="X", condition=AlertCondition.PCT_CHANGE_BELOW, value=-0.05)
    hits = evaluate_alerts([a], {"X": _df([100, 90])})
    assert len(hits) == 1


def test_rsi_above_triggers_on_uptrend():
    # Strong uptrend with tiny pullbacks pushes RSI > 70
    import random
    random.seed(0)
    prices = [100.0]
    for _ in range(60):
        prices.append(prices[-1] + random.choice([1.0, 1.0, 1.0, 1.0, -0.2]))
    a = Alert(ticker="X", condition=AlertCondition.RSI_ABOVE, value=70)
    hits = evaluate_alerts([a], {"X": _df(prices)})
    assert len(hits) == 1
    assert float(hits[0].observed) > 70


def test_rsi_below_triggers_on_downtrend():
    import random
    random.seed(1)
    prices = [200.0]
    for _ in range(60):
        prices.append(prices[-1] + random.choice([-1.0, -1.0, -1.0, -1.0, 0.2]))
    a = Alert(ticker="X", condition=AlertCondition.RSI_BELOW, value=30)
    hits = evaluate_alerts([a], {"X": _df(prices)})
    assert len(hits) == 1


def test_signal_label_match():
    a = Alert(ticker="MSFT", condition=AlertCondition.SIGNAL_LABEL, value="watch")
    hits = evaluate_alerts([a], {"MSFT": _df([100, 101])},
                           signal_labels={"MSFT": "watch"})
    assert len(hits) == 1
    hits2 = evaluate_alerts([a], {"MSFT": _df([100, 101])},
                            signal_labels={"MSFT": "skip"})
    assert hits2 == []


def test_cooldown_blocks_second_fire():
    a = Alert(ticker="X", condition=AlertCondition.PRICE_ABOVE, value=50,
              cooldown_hours=12)
    df = _df([100, 110])
    now = datetime.now(timezone.utc)
    hits1 = evaluate_alerts([a], {"X": df}, now=now)
    assert len(hits1) == 1
    assert a.last_fired_at is not None
    # second eval one minute later: still in cooldown
    hits2 = evaluate_alerts([a], {"X": df}, now=now + timedelta(minutes=1))
    assert hits2 == []
    # past cooldown: fires again
    hits3 = evaluate_alerts([a], {"X": df}, now=now + timedelta(hours=13))
    assert len(hits3) == 1


def test_disabled_alert_skipped():
    a = Alert(ticker="X", condition=AlertCondition.PRICE_ABOVE, value=50,
              enabled=False)
    hits = evaluate_alerts([a], {"X": _df([100, 110])})
    assert hits == []


def test_missing_ohlcv_no_crash():
    a = Alert(ticker="MISSING", condition=AlertCondition.PRICE_ABOVE, value=1)
    hits = evaluate_alerts([a], {})
    assert hits == []


class _RecordingNotifier:
    def __init__(self):
        self.sent = []

    def send(self, text):
        self.sent.append(text)
        return True


def test_dispatch_hits_sends_to_notifiers():
    hit = AlertHit(alert_id="x", ticker="MSFT", condition="price_above",
                   value=100, observed=110, fired_at="2026-01-01T00:00:00+00:00")
    n1, n2 = _RecordingNotifier(), _RecordingNotifier()
    count = dispatch_hits([hit], [n1, n2])
    assert count == 2
    assert "MSFT" in n1.sent[0]
    assert "—" not in n1.sent[0]  # no em-dashes in user-facing copy


def test_hit_format_has_no_em_dash():
    hit = AlertHit(alert_id="x", ticker="MSFT", condition="price_above",
                   value=100, observed=110, fired_at="t", note="break out")
    s = hit.format()
    assert "—" not in s
    assert "break out" in s
