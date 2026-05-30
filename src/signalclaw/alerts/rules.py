"""Alert rule definitions.

Conditions are intentionally simple and explicit. Each Alert is a single
trigger; combinations are expressed as multiple alerts.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, Optional
import uuid


class AlertCondition(str, Enum):
    PRICE_ABOVE = "price_above"
    PRICE_BELOW = "price_below"
    PCT_CHANGE_ABOVE = "pct_change_above"  # absolute, 1-day, e.g. 0.05 means +5%
    PCT_CHANGE_BELOW = "pct_change_below"  # e.g. -0.05 means down >5%
    RSI_ABOVE = "rsi_above"
    RSI_BELOW = "rsi_below"
    SIGNAL_LABEL = "signal_label"  # value is "watch"/"hold"/"skip"


@dataclass
class Alert:
    ticker: str
    condition: AlertCondition
    value: float | str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    note: str = ""
    enabled: bool = True
    cooldown_hours: int = 12
    last_fired_at: Optional[str] = None  # ISO8601 UTC

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["condition"] = self.condition.value
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Alert":
        return cls(
            id=d.get("id", uuid.uuid4().hex[:12]),
            ticker=d["ticker"].upper(),
            condition=AlertCondition(d["condition"]),
            value=d["value"],
            note=d.get("note", ""),
            enabled=bool(d.get("enabled", True)),
            cooldown_hours=int(d.get("cooldown_hours", 12)),
            last_fired_at=d.get("last_fired_at"),
        )

    def in_cooldown(self, now: Optional[datetime] = None) -> bool:
        if not self.last_fired_at:
            return False
        now = now or datetime.now(timezone.utc)
        try:
            last = datetime.fromisoformat(self.last_fired_at)
        except ValueError:
            return False
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        delta_h = (now - last).total_seconds() / 3600.0
        return delta_h < self.cooldown_hours


@dataclass
class AlertHit:
    alert_id: str
    ticker: str
    condition: str
    value: float | str
    observed: float | str
    fired_at: str
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def format(self) -> str:
        return (
            f"[ALERT] {self.ticker} {self.condition} "
            f"target={self.value} observed={self.observed}"
            + (f" ({self.note})" if self.note else "")
        )
