from __future__ import annotations
import pytest
from signalclaw.portfolio.scaling import (
    ScalingPlan, ScaleRung, ScaleAction, PlanStatus, PriceBar,
    evaluate_plan, ScalingPlanStore,
)


def _plan(**kw):
    defaults = dict(
        ticker="AAA", entry=100.0, initial_stop=95.0, initial_shares=100,
        rungs=[
            ScaleRung(r_multiple=1.0, action=ScaleAction.ADD,
                      size_fraction=0.5, new_stop_r=0.0),
            ScaleRung(r_multiple=2.0, action=ScaleAction.TRIM,
                      size_fraction=0.25, new_stop_r=1.0),
            ScaleRung(r_multiple=3.0, action=ScaleAction.TRIM,
                      size_fraction=0.50, new_stop_r=2.0),
        ],
    )
    defaults.update(kw)
    return ScalingPlan(**defaults)


def _bars(highs, lows=None):
    lows = lows or [h * 0.99 for h in highs]
    return [PriceBar(index=i, high=h, low=l)
            for i, (h, l) in enumerate(zip(highs, lows))]


def test_plan_validates_inputs():
    with pytest.raises(ValueError):
        ScalingPlan(ticker="", entry=10, initial_stop=5, initial_shares=10,
                    rungs=[ScaleRung(1.0, ScaleAction.ADD, 0.5)])
    with pytest.raises(ValueError):
        ScalingPlan(ticker="X", entry=10, initial_stop=11, initial_shares=10,
                    rungs=[ScaleRung(1.0, ScaleAction.ADD, 0.5)])
    with pytest.raises(ValueError):
        # rungs not sorted
        ScalingPlan(ticker="X", entry=10, initial_stop=5, initial_shares=10,
                    rungs=[ScaleRung(2.0, ScaleAction.ADD, 0.5),
                           ScaleRung(1.0, ScaleAction.ADD, 0.5)])
    with pytest.raises(ValueError):
        ScaleRung(r_multiple=-1.0, action=ScaleAction.ADD, size_fraction=0.5)


def test_r_property_is_entry_minus_initial_stop():
    p = _plan(entry=100, initial_stop=92)
    assert p.r == 8


def test_evaluate_plan_triggers_first_add_rung_on_high_breach():
    p = _plan()
    events, new = evaluate_plan(p, _bars([102, 104, 105]))
    # R = 5, first rung at entry+1R = 105
    assert len(events) == 1
    e = events[0]
    assert e.action is ScaleAction.ADD
    assert e.rung_index == 0
    assert e.trigger_price == 105.0
    assert e.shares == 50
    assert e.new_stop == 100.0  # entry + 0R
    assert new.triggered == [0]
    assert new.status is PlanStatus.ACTIVE


def test_evaluate_plan_fires_all_rungs_on_strong_rally():
    p = _plan()
    events, new = evaluate_plan(p, _bars([105, 110, 115]))
    assert [e.rung_index for e in events] == [0, 1, 2]
    actions = [e.action for e in events]
    assert actions == [ScaleAction.ADD, ScaleAction.TRIM, ScaleAction.TRIM]
    assert events[0].shares == 50
    assert events[1].shares == -25
    assert events[2].shares == -50
    assert new.status is PlanStatus.DONE


def test_evaluate_plan_does_not_refire_triggered_rungs():
    p = _plan()
    _, after_first = evaluate_plan(p, _bars([105]))
    assert after_first.triggered == [0]
    events2, after_second = evaluate_plan(after_first, _bars([106, 107, 108]))
    assert events2 == []
    assert after_second.triggered == [0]


def test_new_stop_only_moves_up():
    p = _plan()
    events, new = evaluate_plan(p, _bars([105, 110]))
    assert events[0].new_stop == 100.0      # rung 0 raises stop to entry
    assert events[1].new_stop == 105.0      # rung 1 raises stop to entry + 1R


def test_cancelled_plan_yields_no_events():
    p = _plan()
    p.status = PlanStatus.CANCELLED
    events, new = evaluate_plan(p, _bars([200]))
    assert events == []
    assert new.status is PlanStatus.CANCELLED


def test_round_trip_dict_preserves_plan():
    p = _plan()
    d = p.to_dict()
    p2 = ScalingPlan.from_dict(d)
    assert p2.ticker == p.ticker
    assert p2.entry == p.entry
    assert [r.r_multiple for r in p2.rungs] == [r.r_multiple for r in p.rungs]
    assert p2.plan_id == p.plan_id


def test_store_upsert_and_get_round_trip(tmp_path):
    store = ScalingPlanStore(tmp_path / "scaling.json")
    p = _plan()
    store.upsert(p)
    got = store.get(p.plan_id)
    assert got is not None
    assert got.ticker == "AAA"
    assert len(store.list()) == 1


def test_store_upsert_updates_existing_plan(tmp_path):
    store = ScalingPlanStore(tmp_path / "scaling.json")
    p = _plan()
    store.upsert(p)
    p.triggered = [0]
    store.upsert(p)
    assert len(store.list()) == 1
    assert store.get(p.plan_id).triggered == [0]


def test_store_cancel_marks_plan_cancelled(tmp_path):
    store = ScalingPlanStore(tmp_path / "scaling.json")
    p = _plan()
    store.upsert(p)
    assert store.cancel(p.plan_id) is True
    assert store.get(p.plan_id).status is PlanStatus.CANCELLED
    assert store.cancel("nope") is False


def test_store_delete_removes_plan(tmp_path):
    store = ScalingPlanStore(tmp_path / "scaling.json")
    p = _plan()
    store.upsert(p)
    assert store.delete(p.plan_id) is True
    assert store.get(p.plan_id) is None
    assert store.delete(p.plan_id) is False


def test_price_bar_validation():
    with pytest.raises(ValueError):
        PriceBar(0, high=-1, low=1)
    with pytest.raises(ValueError):
        PriceBar(0, high=5, low=10)


def test_total_add_capped_and_total_trim_capped():
    with pytest.raises(ValueError):
        ScalingPlan(
            ticker="X", entry=10, initial_stop=5, initial_shares=10,
            rungs=[ScaleRung(1.0, ScaleAction.TRIM, 0.6),
                   ScaleRung(2.0, ScaleAction.TRIM, 0.6)],
        )
    with pytest.raises(ValueError):
        ScalingPlan(
            ticker="X", entry=10, initial_stop=5, initial_shares=10,
            rungs=[ScaleRung(1.0, ScaleAction.ADD, 2.0),
                   ScaleRung(2.0, ScaleAction.ADD, 2.0)],
        )
