"""Bracket order plans: structured entry/stop/target trade plans.

A bracket plan captures a planned trade before it executes: ticker,
side, intended entry, stop loss, take profit, and planned shares.
After the trade plays out, callers attach an actual entry price and
an exit price (with reason), and the module computes the realized
R multiple versus the originally planned 1R risk.

Storage: JSON file, append by plan_id, atomic in-process via lock.

Why this exists: backtests measure strategy edge, journal captures
narrative. Bracket plans sit between them and answer "did I execute
the plan I wrote down". The realized R multiple distribution is the
primary feedback signal for discretionary refinement.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import csv
import io
import json
import threading
import uuid


VALID_SIDES = ("long", "short")
VALID_STATUS = ("open", "filled", "closed", "cancelled")
VALID_EXIT_REASONS = ("stop", "target", "manual", "expiry", "other")


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    return "brk_" + uuid.uuid4().hex[:12]


@dataclass
class BracketPlan:
    ticker: str
    side: str                 # long | short
    entry: float              # planned entry price
    stop: float               # planned stop loss price
    target: float             # planned take profit price
    shares: int               # planned share count, must be > 0
    id: str = field(default_factory=_new_id)
    status: str = "open"      # open|filled|closed|cancelled
    note: str = ""
    created_at: str = field(default_factory=_utc_now)
    updated_at: str = field(default_factory=_utc_now)
    # Lifecycle: filled
    actual_entry: Optional[float] = None
    filled_at: Optional[str] = None
    # Lifecycle: closed
    actual_exit: Optional[float] = None
    exit_reason: Optional[str] = None
    closed_at: Optional[str] = None

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).strip().upper()
        if not self.ticker:
            raise ValueError("ticker required")
        if self.side not in VALID_SIDES:
            raise ValueError(f"side must be one of {VALID_SIDES}")
        for name, val in (("entry", self.entry), ("stop", self.stop), ("target", self.target)):
            if not isinstance(val, (int, float)) or val <= 0:
                raise ValueError(f"{name} must be a positive number")
        self.entry = float(self.entry)
        self.stop = float(self.stop)
        self.target = float(self.target)
        if not isinstance(self.shares, int) or self.shares <= 0:
            raise ValueError("shares must be a positive integer")
        if self.status not in VALID_STATUS:
            raise ValueError(f"status must be one of {VALID_STATUS}")
        # Geometry checks
        if self.side == "long":
            if self.stop >= self.entry:
                raise ValueError("long bracket requires stop < entry")
            if self.target <= self.entry:
                raise ValueError("long bracket requires target > entry")
        else:  # short
            if self.stop <= self.entry:
                raise ValueError("short bracket requires stop > entry")
            if self.target >= self.entry:
                raise ValueError("short bracket requires target < entry")

    # Risk geometry
    @property
    def risk_per_share(self) -> float:
        return abs(self.entry - self.stop)

    @property
    def reward_per_share(self) -> float:
        return abs(self.target - self.entry)

    @property
    def planned_r_multiple(self) -> float:
        r = self.risk_per_share
        return self.reward_per_share / r if r > 0 else 0.0

    @property
    def planned_risk_dollars(self) -> float:
        return self.risk_per_share * self.shares

    def realized_r(self) -> Optional[float]:
        """Realized R multiple using actual_entry vs actual_exit. None if not closed."""
        if self.actual_entry is None or self.actual_exit is None:
            return None
        # 1R is the originally planned risk per share at the plan's entry/stop.
        r_unit = self.risk_per_share
        if r_unit <= 0:
            return 0.0
        direction = 1.0 if self.side == "long" else -1.0
        return direction * (self.actual_exit - self.actual_entry) / r_unit

    def realized_pnl(self) -> Optional[float]:
        if self.actual_entry is None or self.actual_exit is None:
            return None
        direction = 1.0 if self.side == "long" else -1.0
        return direction * (self.actual_exit - self.actual_entry) * self.shares

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["risk_per_share"] = self.risk_per_share
        d["reward_per_share"] = self.reward_per_share
        d["planned_r_multiple"] = self.planned_r_multiple
        d["planned_risk_dollars"] = self.planned_risk_dollars
        d["realized_r"] = self.realized_r()
        d["realized_pnl"] = self.realized_pnl()
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BracketPlan":
        # Strip derived fields if present
        keep = {
            "ticker", "side", "entry", "stop", "target", "shares", "id",
            "status", "note", "created_at", "updated_at",
            "actual_entry", "filled_at",
            "actual_exit", "exit_reason", "closed_at",
        }
        clean = {k: v for k, v in d.items() if k in keep}
        return cls(**clean)


class BracketStore:
    """Append by id; updates replace in place."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"plans": []}, indent=2))

    def _read(self) -> List[BracketPlan]:
        if not self.path.exists():
            return []
        raw = json.loads(self.path.read_text() or '{"plans":[]}')
        return [BracketPlan.from_dict(p) for p in raw.get("plans", [])]

    def _write(self, plans: List[BracketPlan]) -> None:
        # Persist only the source fields, not derived
        keep = {
            "ticker", "side", "entry", "stop", "target", "shares", "id",
            "status", "note", "created_at", "updated_at",
            "actual_entry", "filled_at",
            "actual_exit", "exit_reason", "closed_at",
        }
        out = []
        for p in plans:
            d = asdict(p)
            out.append({k: d[k] for k in keep})
        self.path.write_text(json.dumps({"plans": out}, indent=2, sort_keys=True))

    def list(
        self,
        *,
        ticker: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[BracketPlan]:
        plans = self._read()
        if ticker:
            t = ticker.upper()
            plans = [p for p in plans if p.ticker == t]
        if status:
            if status not in VALID_STATUS:
                raise ValueError(f"status must be one of {VALID_STATUS}")
            plans = [p for p in plans if p.status == status]
        return plans

    def get(self, plan_id: str) -> Optional[BracketPlan]:
        for p in self._read():
            if p.id == plan_id:
                return p
        return None

    def add(self, plan: BracketPlan) -> BracketPlan:
        with self._lock:
            plans = self._read()
            if any(p.id == plan.id for p in plans):
                raise ValueError(f"plan id collision: {plan.id}")
            plans.append(plan)
            self._write(plans)
        return plan

    def remove(self, plan_id: str) -> bool:
        with self._lock:
            plans = self._read()
            new = [p for p in plans if p.id != plan_id]
            if len(new) == len(plans):
                return False
            self._write(new)
        return True

    def fill(self, plan_id: str, actual_entry: float, when: Optional[str] = None) -> BracketPlan:
        if actual_entry <= 0:
            raise ValueError("actual_entry must be positive")
        with self._lock:
            plans = self._read()
            for p in plans:
                if p.id == plan_id:
                    if p.status not in ("open",):
                        raise ValueError(f"cannot fill plan in status {p.status}")
                    p.actual_entry = float(actual_entry)
                    p.filled_at = when or _utc_now()
                    p.status = "filled"
                    p.updated_at = _utc_now()
                    self._write(plans)
                    return p
        raise KeyError(plan_id)

    def close(
        self,
        plan_id: str,
        actual_exit: float,
        reason: str,
        when: Optional[str] = None,
    ) -> BracketPlan:
        if actual_exit <= 0:
            raise ValueError("actual_exit must be positive")
        if reason not in VALID_EXIT_REASONS:
            raise ValueError(f"reason must be one of {VALID_EXIT_REASONS}")
        with self._lock:
            plans = self._read()
            for p in plans:
                if p.id == plan_id:
                    if p.status != "filled":
                        raise ValueError(
                            f"cannot close plan in status {p.status}; fill it first"
                        )
                    p.actual_exit = float(actual_exit)
                    p.exit_reason = reason
                    p.closed_at = when or _utc_now()
                    p.status = "closed"
                    p.updated_at = _utc_now()
                    self._write(plans)
                    return p
        raise KeyError(plan_id)

    def cancel(self, plan_id: str) -> BracketPlan:
        with self._lock:
            plans = self._read()
            for p in plans:
                if p.id == plan_id:
                    if p.status not in ("open",):
                        raise ValueError(f"cannot cancel plan in status {p.status}")
                    p.status = "cancelled"
                    p.updated_at = _utc_now()
                    self._write(plans)
                    return p
        raise KeyError(plan_id)

    def export_csv(self) -> str:
        plans = self._read()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow([
            "id", "ticker", "side", "shares", "entry", "stop", "target",
            "planned_r_multiple", "planned_risk_dollars",
            "status", "actual_entry", "actual_exit", "exit_reason",
            "realized_r", "realized_pnl",
            "created_at", "filled_at", "closed_at", "note",
        ])
        for p in plans:
            w.writerow([
                p.id, p.ticker, p.side, p.shares, p.entry, p.stop, p.target,
                round(p.planned_r_multiple, 4), round(p.planned_risk_dollars, 4),
                p.status, p.actual_entry, p.actual_exit, p.exit_reason or "",
                ("" if p.realized_r() is None else round(p.realized_r(), 4)),
                ("" if p.realized_pnl() is None else round(p.realized_pnl(), 4)),
                p.created_at, p.filled_at or "", p.closed_at or "", p.note,
            ])
        return buf.getvalue()


@dataclass
class BracketStats:
    total: int
    open: int
    filled: int
    closed: int
    cancelled: int
    win_rate: float           # closed where realized_r > 0
    avg_r: float              # mean realized_r across closed
    median_r: float
    expectancy: float         # win_rate * avg_win_r + (1-win_rate) * avg_loss_r
    avg_win_r: float
    avg_loss_r: float
    total_realized_pnl: float
    by_exit_reason: Dict[str, int]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def compute_stats(plans: List[BracketPlan]) -> BracketStats:
    by_status = {s: 0 for s in VALID_STATUS}
    for p in plans:
        by_status[p.status] = by_status.get(p.status, 0) + 1

    closed = [p for p in plans if p.status == "closed" and p.realized_r() is not None]
    rs = [p.realized_r() or 0.0 for p in closed]
    pnls = [p.realized_pnl() or 0.0 for p in closed]
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    win_rate = (len(wins) / len(rs)) if rs else 0.0
    avg_r = (sum(rs) / len(rs)) if rs else 0.0
    median_r = _median(rs)
    avg_win_r = (sum(wins) / len(wins)) if wins else 0.0
    avg_loss_r = (sum(losses) / len(losses)) if losses else 0.0
    expectancy = win_rate * avg_win_r + (1.0 - win_rate) * avg_loss_r

    by_reason: Dict[str, int] = {}
    for p in closed:
        key = p.exit_reason or "other"
        by_reason[key] = by_reason.get(key, 0) + 1

    return BracketStats(
        total=len(plans),
        open=by_status["open"],
        filled=by_status["filled"],
        closed=by_status["closed"],
        cancelled=by_status["cancelled"],
        win_rate=round(win_rate, 6),
        avg_r=round(avg_r, 6),
        median_r=round(median_r, 6),
        expectancy=round(expectancy, 6),
        avg_win_r=round(avg_win_r, 6),
        avg_loss_r=round(avg_loss_r, 6),
        total_realized_pnl=round(sum(pnls), 6),
        by_exit_reason=by_reason,
    )


def _median(xs: List[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0
