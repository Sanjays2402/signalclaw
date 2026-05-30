"""Portfolio data model: lots, positions, trades.

Lots are recorded individually so realized P&L uses FIFO cost basis.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Dict, List
import uuid


class TradeSide(str, Enum):
    BUY = "buy"
    SELL = "sell"


@dataclass
class Lot:
    """An open buy lot waiting to be matched against future sells (FIFO)."""
    ticker: str
    quantity: float
    cost_basis: float  # per-share
    acquired: str  # ISO date
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Lot":
        return cls(
            id=d.get("id", uuid.uuid4().hex[:10]),
            ticker=d["ticker"].upper(),
            quantity=float(d["quantity"]),
            cost_basis=float(d["cost_basis"]),
            acquired=str(d["acquired"]),
        )


@dataclass
class Trade:
    """A single executed buy or sell. Sells generate realized P&L."""
    ticker: str
    side: TradeSide
    quantity: float
    price: float
    date: str  # ISO date
    fees: float = 0.0
    note: str = ""
    realized_pnl: float = 0.0  # filled in on apply()
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["side"] = self.side.value
        return d

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Trade":
        return cls(
            id=d.get("id", uuid.uuid4().hex[:10]),
            ticker=d["ticker"].upper(),
            side=TradeSide(d["side"]),
            quantity=float(d["quantity"]),
            price=float(d["price"]),
            date=str(d["date"]),
            fees=float(d.get("fees", 0.0)),
            note=d.get("note", ""),
            realized_pnl=float(d.get("realized_pnl", 0.0)),
        )


@dataclass
class Position:
    """Aggregated open position for one ticker built from open lots."""
    ticker: str
    lots: List[Lot] = field(default_factory=list)

    @property
    def quantity(self) -> float:
        return sum(l.quantity for l in self.lots)

    @property
    def avg_cost(self) -> float:
        q = self.quantity
        if q <= 0:
            return 0.0
        return sum(l.quantity * l.cost_basis for l in self.lots) / q

    @property
    def cost(self) -> float:
        return sum(l.quantity * l.cost_basis for l in self.lots)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ticker": self.ticker,
            "quantity": self.quantity,
            "avg_cost": self.avg_cost,
            "cost": self.cost,
            "lots": [l.to_dict() for l in self.lots],
        }


def apply_trades(trades: List[Trade]) -> Dict[str, Position]:
    """Rebuild positions by replaying trades in date order, FIFO.

    Mutates each trade's realized_pnl. Returns ticker -> open Position.
    Sells beyond held quantity are clipped to held quantity (and a flag could
    be added later); we do not allow shorts in this model.
    """
    open_lots: Dict[str, List[Lot]] = {}
    sorted_trades = sorted(trades, key=lambda t: (t.date, t.id))
    for tr in sorted_trades:
        t = tr.ticker.upper()
        if tr.side == TradeSide.BUY:
            # spread fees across cost basis
            effective_cost = tr.price + (tr.fees / tr.quantity if tr.quantity else 0.0)
            lot = Lot(ticker=t, quantity=tr.quantity, cost_basis=effective_cost,
                      acquired=tr.date)
            open_lots.setdefault(t, []).append(lot)
            tr.realized_pnl = 0.0
        else:  # SELL
            remaining = tr.quantity
            realized = -tr.fees
            lots = open_lots.get(t, [])
            while remaining > 1e-9 and lots:
                lot = lots[0]
                take = min(lot.quantity, remaining)
                realized += take * (tr.price - lot.cost_basis)
                lot.quantity -= take
                remaining -= take
                if lot.quantity <= 1e-9:
                    lots.pop(0)
            tr.realized_pnl = realized
            if not lots:
                open_lots.pop(t, None)
    return {
        t: Position(ticker=t, lots=lots)
        for t, lots in open_lots.items() if lots
    }
