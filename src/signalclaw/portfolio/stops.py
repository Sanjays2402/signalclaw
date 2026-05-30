"""Stop-loss, take-profit, and trailing-stop monitor for open positions.

A `StopRule` is attached per-ticker and persisted alongside the portfolio.
Each rule produces zero or more `StopEvent`s when evaluated against a price
series. Trailing stops use the highest close since rule creation (or last
reset) as the reference price.

Rules are advisory: they do not execute trades. Consumers wire them to the
notifier of their choice.
"""
from __future__ import annotations
from dataclasses import dataclass, asdict, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
import json
import uuid


class StopKind(str, Enum):
    STOP_LOSS = "stop_loss"        # fixed price floor (long)
    TAKE_PROFIT = "take_profit"    # fixed price ceiling (long)
    TRAILING = "trailing"          # percent below trailing high


@dataclass
class StopRule:
    ticker: str
    kind: StopKind
    # For STOP_LOSS / TAKE_PROFIT: price level. For TRAILING: percent (0.10 == 10%).
    value: float
    # Used only for TRAILING; tracks the highest seen close since arming.
    high_water: Optional[float] = None
    armed_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StopRule":
        return cls(
            id=d.get("id", uuid.uuid4().hex[:10]),
            ticker=str(d["ticker"]).upper(),
            kind=StopKind(d["kind"]),
            value=float(d["value"]),
            high_water=(float(d["high_water"]) if d.get("high_water") is not None else None),
            armed_at=str(d.get("armed_at", datetime.utcnow().isoformat())),
            note=str(d.get("note", "")),
        )


@dataclass
class StopEvent:
    rule_id: str
    ticker: str
    kind: str
    trigger_price: float
    reference_price: float  # threshold that was crossed
    timestamp: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def evaluate_rule(rule: StopRule, last_price: float) -> Optional[StopEvent]:
    """Return a StopEvent if the rule fires at `last_price`, else None.

    For TRAILING rules, mutates `rule.high_water` upward as needed. Caller is
    responsible for persisting the rule after evaluation.
    """
    if last_price is None or last_price != last_price:  # NaN guard
        return None
    now = datetime.utcnow().isoformat()
    if rule.kind == StopKind.STOP_LOSS:
        if last_price <= rule.value:
            return StopEvent(rule.id, rule.ticker, rule.kind.value,
                             last_price, rule.value, now)
        return None
    if rule.kind == StopKind.TAKE_PROFIT:
        if last_price >= rule.value:
            return StopEvent(rule.id, rule.ticker, rule.kind.value,
                             last_price, rule.value, now)
        return None
    if rule.kind == StopKind.TRAILING:
        # Update high-water
        if rule.high_water is None or last_price > rule.high_water:
            rule.high_water = last_price
        threshold = rule.high_water * (1.0 - rule.value)
        if last_price <= threshold:
            return StopEvent(rule.id, rule.ticker, rule.kind.value,
                             last_price, threshold, now)
        return None
    return None


def evaluate_rules(rules: Iterable[StopRule], prices: Dict[str, float]) -> List[StopEvent]:
    """Evaluate many rules against a {ticker: last_price} map."""
    out: List[StopEvent] = []
    for rule in rules:
        px = prices.get(rule.ticker.upper())
        if px is None:
            continue
        ev = evaluate_rule(rule, float(px))
        if ev is not None:
            out.append(ev)
    return out


class StopStore:
    """JSON-backed store for stop rules."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text("[]")

    def _read(self) -> List[StopRule]:
        raw = json.loads(self.path.read_text() or "[]")
        return [StopRule.from_dict(r) for r in raw]

    def _write(self, rules: List[StopRule]) -> None:
        self.path.write_text(json.dumps([r.to_dict() for r in rules], indent=2))

    def list(self) -> List[StopRule]:
        return self._read()

    def list_for(self, ticker: str) -> List[StopRule]:
        t = ticker.upper()
        return [r for r in self._read() if r.ticker == t]

    def add(self, rule: StopRule) -> StopRule:
        rules = self._read()
        rules.append(rule)
        self._write(rules)
        return rule

    def remove(self, rule_id: str) -> bool:
        rules = self._read()
        n = len(rules)
        rules = [r for r in rules if r.id != rule_id]
        self._write(rules)
        return len(rules) < n

    def update(self, rule: StopRule) -> bool:
        rules = self._read()
        for i, r in enumerate(rules):
            if r.id == rule.id:
                rules[i] = rule
                self._write(rules)
                return True
        return False

    def clear(self) -> None:
        self._write([])
