from __future__ import annotations
import json
from pathlib import Path

from signalclaw.portfolio.stops import (
    StopRule, StopKind, StopStore, evaluate_rule, evaluate_rules,
)


def test_stop_loss_triggers_at_or_below():
    r = StopRule(ticker="MSFT", kind=StopKind.STOP_LOSS, value=100.0)
    assert evaluate_rule(r, 101.0) is None
    ev = evaluate_rule(r, 99.5)
    assert ev is not None
    assert ev.kind == "stop_loss"
    assert ev.trigger_price == 99.5
    assert ev.reference_price == 100.0


def test_take_profit_triggers_at_or_above():
    r = StopRule(ticker="MSFT", kind=StopKind.TAKE_PROFIT, value=200.0)
    assert evaluate_rule(r, 199.99) is None
    ev = evaluate_rule(r, 200.5)
    assert ev is not None
    assert ev.kind == "take_profit"


def test_trailing_stop_tracks_high_and_fires_on_pullback():
    r = StopRule(ticker="TSLA", kind=StopKind.TRAILING, value=0.10)  # 10% trail
    # Climb
    assert evaluate_rule(r, 100.0) is None
    assert r.high_water == 100.0
    assert evaluate_rule(r, 120.0) is None
    assert r.high_water == 120.0
    # Pull back 5% off 120 → no trigger
    assert evaluate_rule(r, 115.0) is None
    # Pull back 10% off 120 → trigger
    ev = evaluate_rule(r, 108.0)
    assert ev is not None
    assert ev.kind == "trailing"
    assert ev.reference_price == 108.0  # 120 * 0.9


def test_trailing_stop_ignores_nan():
    r = StopRule(ticker="X", kind=StopKind.TRAILING, value=0.05)
    assert evaluate_rule(r, float("nan")) is None
    assert r.high_water is None


def test_evaluate_rules_batch():
    rules = [
        StopRule(ticker="A", kind=StopKind.STOP_LOSS, value=10.0),
        StopRule(ticker="B", kind=StopKind.TAKE_PROFIT, value=50.0),
        StopRule(ticker="C", kind=StopKind.STOP_LOSS, value=5.0),
    ]
    events = evaluate_rules(rules, {"A": 9.0, "B": 60.0, "C": 7.0})
    kinds = sorted(e.ticker for e in events)
    assert kinds == ["A", "B"]


def test_store_roundtrip(tmp_path: Path):
    store = StopStore(tmp_path / "stops.json")
    r1 = store.add(StopRule(ticker="MSFT", kind=StopKind.STOP_LOSS, value=400.0))
    store.add(StopRule(ticker="TSLA", kind=StopKind.TRAILING, value=0.08, high_water=250.0))
    assert len(store.list()) == 2
    assert len(store.list_for("msft")) == 1
    # Update high water and persist
    rule = store.list_for("TSLA")[0]
    rule.high_water = 300.0
    assert store.update(rule) is True
    again = store.list_for("TSLA")[0]
    assert again.high_water == 300.0
    # Remove
    assert store.remove(r1.id) is True
    assert len(store.list()) == 1
    # JSON is valid
    assert json.loads((tmp_path / "stops.json").read_text())


def test_store_remove_missing_returns_false(tmp_path: Path):
    store = StopStore(tmp_path / "stops.json")
    assert store.remove("nope") is False
