"""P&L computation: per-position and portfolio snapshots."""
from __future__ import annotations
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional

from .position import Position, Trade


@dataclass
class PositionPnL:
    ticker: str
    quantity: float
    avg_cost: float
    last_price: Optional[float]
    market_value: float
    cost: float
    unrealized_pnl: float
    unrealized_pct: float
    realized_pnl: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PortfolioSnapshot:
    positions: List[PositionPnL]
    total_cost: float
    total_market_value: float
    total_unrealized: float
    total_realized: float
    weights: Dict[str, float]  # ticker -> share of market value

    def to_dict(self) -> dict:
        return {
            "positions": [p.to_dict() for p in self.positions],
            "total_cost": self.total_cost,
            "total_market_value": self.total_market_value,
            "total_unrealized": self.total_unrealized,
            "total_realized": self.total_realized,
            "weights": self.weights,
        }


def compute_position_pnl(
    position: Position,
    last_price: Optional[float],
    realized_pnl: float = 0.0,
) -> PositionPnL:
    q = position.quantity
    cost = position.cost
    avg = position.avg_cost
    if last_price is None or last_price <= 0:
        mv = 0.0
        unreal = 0.0
        pct = 0.0
    else:
        mv = q * last_price
        unreal = mv - cost
        pct = (unreal / cost) if cost > 0 else 0.0
    return PositionPnL(
        ticker=position.ticker,
        quantity=q,
        avg_cost=avg,
        last_price=last_price,
        market_value=mv,
        cost=cost,
        unrealized_pnl=unreal,
        unrealized_pct=pct,
        realized_pnl=realized_pnl,
    )


def _realized_by_ticker(trades: List[Trade]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for t in trades:
        out[t.ticker.upper()] = out.get(t.ticker.upper(), 0.0) + float(t.realized_pnl)
    return out


def compute_snapshot(
    positions: Dict[str, Position],
    last_prices: Dict[str, float],
    trades: Optional[List[Trade]] = None,
) -> PortfolioSnapshot:
    realized = _realized_by_ticker(trades or [])
    rows: List[PositionPnL] = []
    for t, pos in positions.items():
        lp = last_prices.get(t)
        rows.append(compute_position_pnl(pos, lp, realized_pnl=realized.get(t, 0.0)))
    # Realized P&L from closed-out tickers (no remaining position)
    closed_realized = 0.0
    for t, r in realized.items():
        if t not in positions:
            closed_realized += r
    total_cost = sum(p.cost for p in rows)
    total_mv = sum(p.market_value for p in rows)
    total_unreal = sum(p.unrealized_pnl for p in rows)
    total_real = sum(p.realized_pnl for p in rows) + closed_realized
    weights: Dict[str, float] = {}
    if total_mv > 0:
        for p in rows:
            weights[p.ticker] = p.market_value / total_mv
    rows.sort(key=lambda p: p.market_value, reverse=True)
    return PortfolioSnapshot(
        positions=rows,
        total_cost=total_cost,
        total_market_value=total_mv,
        total_unrealized=total_unreal,
        total_realized=total_real,
        weights=weights,
    )
