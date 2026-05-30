"""Position scaling plans.

A scaling plan attaches to an open long position and triggers child
orders as price advances or retreats in R-multiples (R = entry minus
initial stop). It supports two move kinds:

* ``ScaleAction.ADD`` -- pyramid in additional shares when price hits a
  positive R multiple. Each rung has its own size (fraction of the
  original position) and an updated stop (typically the prior rung's
  entry or a trailing fraction of the move).
* ``ScaleAction.TRIM`` -- scale out partial shares at positive R targets.

Plans are deterministic given a price path: ``evaluate_plan`` walks bars
in order and emits a list of ``ScaleEvent``s for triggered rungs.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import List, Mapping, Sequence
import json
import threading
import uuid


class ScaleAction(str, Enum):
    ADD = "add"
    TRIM = "trim"


class PlanStatus(str, Enum):
    ACTIVE = "active"
    DONE = "done"
    CANCELLED = "cancelled"


@dataclass
class ScaleRung:
    r_multiple: float          # signed: positive for trigger above entry
    action: ScaleAction
    size_fraction: float       # fraction of initial_shares (>0)
    new_stop_r: float | None = None   # if set, raise stop to entry + new_stop_r*R

    def __post_init__(self) -> None:
        if self.size_fraction <= 0:
            raise ValueError("size_fraction must be > 0")
        if self.action is ScaleAction.ADD and self.r_multiple <= 0:
            raise ValueError("ADD rungs require r_multiple > 0")
        if self.action is ScaleAction.TRIM and self.r_multiple <= 0:
            raise ValueError("TRIM rungs require r_multiple > 0")


@dataclass
class ScalingPlan:
    ticker: str
    entry: float
    initial_stop: float
    initial_shares: int
    rungs: List[ScaleRung]
    plan_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    status: PlanStatus = PlanStatus.ACTIVE
    triggered: List[int] = field(default_factory=list)   # indexes of done rungs

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).strip().upper()
        if not self.ticker:
            raise ValueError("ticker required")
        if self.entry <= 0:
            raise ValueError("entry must be > 0")
        if self.initial_stop <= 0 or self.initial_stop >= self.entry:
            raise ValueError("initial_stop must be in (0, entry)")
        if self.initial_shares <= 0:
            raise ValueError("initial_shares must be > 0")
        if not self.rungs:
            raise ValueError("at least one rung required")
        # rungs must be in increasing r_multiple order so triggers fire predictably
        rs = [r.r_multiple for r in self.rungs]
        if rs != sorted(rs):
            raise ValueError("rungs must be sorted by r_multiple ascending")
        total_add = sum(r.size_fraction for r in self.rungs
                        if r.action is ScaleAction.ADD)
        if total_add > 3.0:
            raise ValueError("total add fraction exceeds 3.0x initial size")
        total_trim = sum(r.size_fraction for r in self.rungs
                         if r.action is ScaleAction.TRIM)
        if total_trim > 1.0 + 1e-9:
            raise ValueError("total trim fraction exceeds 1.0x initial size")

    @property
    def r(self) -> float:
        return self.entry - self.initial_stop

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        d["rungs"] = [{
            "r_multiple": r.r_multiple,
            "action": r.action.value,
            "size_fraction": r.size_fraction,
            "new_stop_r": r.new_stop_r,
        } for r in self.rungs]
        return d

    @staticmethod
    def from_dict(d: Mapping) -> "ScalingPlan":
        rungs = [ScaleRung(
            r_multiple=float(x["r_multiple"]),
            action=ScaleAction(x["action"]),
            size_fraction=float(x["size_fraction"]),
            new_stop_r=(None if x.get("new_stop_r") is None
                        else float(x["new_stop_r"])),
        ) for x in d["rungs"]]
        return ScalingPlan(
            ticker=str(d["ticker"]),
            entry=float(d["entry"]),
            initial_stop=float(d["initial_stop"]),
            initial_shares=int(d["initial_shares"]),
            rungs=rungs,
            plan_id=str(d.get("plan_id") or uuid.uuid4().hex[:12]),
            status=PlanStatus(d.get("status", "active")),
            triggered=list(d.get("triggered", [])),
        )


@dataclass(frozen=True)
class ScaleEvent:
    plan_id: str
    ticker: str
    rung_index: int
    action: ScaleAction
    trigger_price: float
    bar_index: int
    shares: int                  # signed: positive = bought, negative = sold
    new_stop: float | None
    r_multiple: float

    def to_dict(self) -> dict:
        d = asdict(self)
        d["action"] = self.action.value
        return d


@dataclass(frozen=True)
class PriceBar:
    index: int
    high: float
    low: float

    def __post_init__(self) -> None:
        if self.high <= 0 or self.low <= 0:
            raise ValueError("bar prices must be > 0")
        if self.high < self.low:
            raise ValueError("bar high must be >= low")


def evaluate_plan(plan: ScalingPlan,
                  bars: Sequence[PriceBar]) -> tuple[List[ScaleEvent], ScalingPlan]:
    """Walk ``bars`` and return all rungs that triggered plus a new plan
    reflecting which rungs have fired and the current stop."""
    if plan.status is not PlanStatus.ACTIVE:
        return [], plan
    events: List[ScaleEvent] = []
    triggered = set(plan.triggered)
    current_stop = plan.initial_stop
    R = plan.r
    for bar in bars:
        for i, rung in enumerate(plan.rungs):
            if i in triggered:
                continue
            trigger_price = plan.entry + rung.r_multiple * R
            # ADD and TRIM both above entry: triggered by bar high reaching it
            if bar.high < trigger_price:
                continue
            shares = int(round(plan.initial_shares * rung.size_fraction))
            if rung.action is ScaleAction.TRIM:
                shares = -shares
            new_stop = current_stop
            if rung.new_stop_r is not None:
                candidate = plan.entry + rung.new_stop_r * R
                if candidate > current_stop:
                    new_stop = candidate
                    current_stop = candidate
            events.append(ScaleEvent(
                plan_id=plan.plan_id, ticker=plan.ticker,
                rung_index=i, action=rung.action,
                trigger_price=round(trigger_price, 6),
                bar_index=bar.index,
                shares=shares,
                new_stop=(round(new_stop, 6)
                          if rung.new_stop_r is not None else None),
                r_multiple=rung.r_multiple,
            ))
            triggered.add(i)
    new_plan = ScalingPlan(
        ticker=plan.ticker, entry=plan.entry,
        initial_stop=plan.initial_stop,
        initial_shares=plan.initial_shares,
        rungs=plan.rungs,
        plan_id=plan.plan_id,
        status=(PlanStatus.DONE if len(triggered) == len(plan.rungs)
                else PlanStatus.ACTIVE),
        triggered=sorted(triggered),
    )
    return events, new_plan


class ScalingPlanStore:
    """JSON-backed store of scaling plans, keyed by plan_id."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"plans": []}))

    def _read(self) -> dict:
        return json.loads(self.path.read_text() or '{"plans": []}')

    def _write(self, data: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def list(self) -> List[ScalingPlan]:
        return [ScalingPlan.from_dict(p) for p in self._read().get("plans", [])]

    def get(self, plan_id: str) -> ScalingPlan | None:
        for p in self.list():
            if p.plan_id == plan_id:
                return p
        return None

    def upsert(self, plan: ScalingPlan) -> None:
        with self._lock:
            data = self._read()
            plans = data.get("plans", [])
            idx = next((i for i, p in enumerate(plans)
                        if p.get("plan_id") == plan.plan_id), None)
            if idx is None:
                plans.append(plan.to_dict())
            else:
                plans[idx] = plan.to_dict()
            data["plans"] = plans
            self._write(data)

    def cancel(self, plan_id: str) -> bool:
        with self._lock:
            data = self._read()
            plans = data.get("plans", [])
            for p in plans:
                if p.get("plan_id") == plan_id:
                    p["status"] = PlanStatus.CANCELLED.value
                    self._write(data)
                    return True
            return False

    def delete(self, plan_id: str) -> bool:
        with self._lock:
            data = self._read()
            before = len(data.get("plans", []))
            data["plans"] = [p for p in data.get("plans", [])
                             if p.get("plan_id") != plan_id]
            self._write(data)
            return len(data["plans"]) < before
