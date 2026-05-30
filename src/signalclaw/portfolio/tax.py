"""Tax-lot accounting beyond FIFO.

The default `apply_trades` in `position.py` matches sells against open buy
lots first-in-first-out (FIFO). For tax planning it is often useful to
compute realized P&L under alternative lot-selection methods without
mutating the canonical trade log:

* HIFO -- highest-cost lot first (minimizes realized gain)
* LIFO -- last-in-first-out (recent lot first)
* FIFO -- baseline, matches `position.apply_trades`
* AVGCO -- single rolling average cost basis (mutual-fund style)

We also include a simple wash-sale window detector: any realized loss
where another buy of the same ticker happened within +/- 30 calendar
days of the loss-generating sell.

These helpers are read-only and pure: they take a trade list and return
a `TaxReport`. They do not change how the portfolio store records
positions.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date
from enum import Enum
from typing import Dict, List, Optional

from .position import Trade, TradeSide, Lot


class LotMethod(str, Enum):
    FIFO = "fifo"
    LIFO = "lifo"
    HIFO = "hifo"
    AVGCO = "avgco"


@dataclass
class RealizedEvent:
    ticker: str
    sell_trade_id: str
    sell_date: str
    quantity: float
    proceeds: float          # quantity * sell_price - allocated fees
    cost_basis: float        # quantity * lot_cost_basis
    realized_pnl: float
    lot_acquired: Optional[str] = None   # ISO date of source lot (None for AVGCO)
    holding_days: Optional[int] = None
    long_term: Optional[bool] = None     # > 365 holding days

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WashSaleFlag:
    ticker: str
    sell_trade_id: str
    sell_date: str
    loss: float
    triggering_buy_id: str
    triggering_buy_date: str
    days_between: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TaxReport:
    method: str
    events: List[RealizedEvent] = field(default_factory=list)
    realized_total: float = 0.0
    realized_short_term: float = 0.0
    realized_long_term: float = 0.0
    wash_sales: List[WashSaleFlag] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "method": self.method,
            "events": [e.to_dict() for e in self.events],
            "realized_total": self.realized_total,
            "realized_short_term": self.realized_short_term,
            "realized_long_term": self.realized_long_term,
            "wash_sales": [w.to_dict() for w in self.wash_sales],
        }


def _parse(d: str) -> date:
    return date.fromisoformat(d[:10])


def _pick_lot(open_lots: List[Lot], method: LotMethod) -> int:
    """Return the index of the open lot to draw from next."""
    if method == LotMethod.LIFO:
        return len(open_lots) - 1
    if method == LotMethod.HIFO:
        best = 0
        for i, l in enumerate(open_lots):
            if l.cost_basis > open_lots[best].cost_basis:
                best = i
        return best
    # FIFO default
    return 0


def _classify_holding(sell_date: str, lot_date: str) -> tuple[int, bool]:
    days = (_parse(sell_date) - _parse(lot_date)).days
    return days, days > 365


def compute_realized(trades: List[Trade], method: LotMethod = LotMethod.FIFO) -> TaxReport:
    """Replay trades and produce per-sell realized events for the chosen method.

    AVGCO maintains a single rolling average per ticker; realized P&L is
    quantity * (sell_price - avg_basis) minus fees. No holding-day info
    is available for AVGCO so events carry ``long_term=None``.
    """
    sorted_trades = sorted(trades, key=lambda t: (t.date, t.id))
    if method == LotMethod.AVGCO:
        return _avgco(sorted_trades)

    open_lots: Dict[str, List[Lot]] = {}
    events: List[RealizedEvent] = []
    short = long_ = total = 0.0
    for tr in sorted_trades:
        t = tr.ticker.upper()
        if tr.side == TradeSide.BUY:
            eff = tr.price + (tr.fees / tr.quantity if tr.quantity else 0.0)
            open_lots.setdefault(t, []).append(
                Lot(ticker=t, quantity=tr.quantity, cost_basis=eff,
                    acquired=tr.date, id=tr.id))
            continue
        remaining = tr.quantity
        fee_per_share = (tr.fees / tr.quantity) if tr.quantity else 0.0
        lots = open_lots.get(t, [])
        while remaining > 1e-9 and lots:
            idx = _pick_lot(lots, method)
            lot = lots[idx]
            take = min(lot.quantity, remaining)
            proceeds = take * (tr.price - fee_per_share)
            cost = take * lot.cost_basis
            pnl = proceeds - cost
            days, lt = _classify_holding(tr.date, lot.acquired)
            events.append(RealizedEvent(
                ticker=t, sell_trade_id=tr.id, sell_date=tr.date,
                quantity=take, proceeds=proceeds, cost_basis=cost,
                realized_pnl=pnl, lot_acquired=lot.acquired,
                holding_days=days, long_term=lt))
            total += pnl
            if lt:
                long_ += pnl
            else:
                short += pnl
            lot.quantity -= take
            remaining -= take
            if lot.quantity <= 1e-9:
                lots.pop(idx)
        if not lots:
            open_lots.pop(t, None)
    return TaxReport(method=method.value, events=events,
                     realized_total=total,
                     realized_short_term=short,
                     realized_long_term=long_)


def _avgco(sorted_trades: List[Trade]) -> TaxReport:
    avg: Dict[str, float] = {}
    qty: Dict[str, float] = {}
    events: List[RealizedEvent] = []
    total = 0.0
    for tr in sorted_trades:
        t = tr.ticker.upper()
        if tr.side == TradeSide.BUY:
            new_qty = qty.get(t, 0.0) + tr.quantity
            buy_cost = tr.quantity * tr.price + tr.fees
            prev_cost = qty.get(t, 0.0) * avg.get(t, 0.0)
            avg[t] = (prev_cost + buy_cost) / new_qty if new_qty else 0.0
            qty[t] = new_qty
            continue
        held = qty.get(t, 0.0)
        take = min(held, tr.quantity)
        if take <= 0:
            continue
        basis = avg.get(t, 0.0)
        proceeds = take * tr.price - tr.fees
        cost = take * basis
        pnl = proceeds - cost
        events.append(RealizedEvent(
            ticker=t, sell_trade_id=tr.id, sell_date=tr.date,
            quantity=take, proceeds=proceeds, cost_basis=cost,
            realized_pnl=pnl, lot_acquired=None, holding_days=None,
            long_term=None))
        total += pnl
        qty[t] = held - take
        if qty[t] <= 1e-9:
            qty.pop(t, None)
            avg.pop(t, None)
    return TaxReport(method=LotMethod.AVGCO.value, events=events,
                     realized_total=total,
                     realized_short_term=0.0, realized_long_term=0.0)


def detect_wash_sales(trades: List[Trade], window_days: int = 30) -> List[WashSaleFlag]:
    """Flag any realized loss (under FIFO) where a buy of the same ticker
    occurred within +/- ``window_days`` of the sell date.

    The 30-day window is the US IRS wash-sale rule. We use FIFO for
    realized-loss identification because it is the canonical broker
    default and other methods produce a different gain/loss split that
    would change which sells appear as losses.
    """
    report = compute_realized(trades, method=LotMethod.FIFO)
    flags: List[WashSaleFlag] = []
    by_ticker_buys: Dict[str, List[Trade]] = {}
    for tr in trades:
        if tr.side == TradeSide.BUY:
            by_ticker_buys.setdefault(tr.ticker.upper(), []).append(tr)
    for ev in report.events:
        if ev.realized_pnl >= 0:
            continue
        sell_d = _parse(ev.sell_date)
        for b in by_ticker_buys.get(ev.ticker, []):
            if b.id == ev.sell_trade_id:
                continue
            bd = _parse(b.date)
            delta = abs((bd - sell_d).days)
            if delta <= window_days and bd != sell_d:
                flags.append(WashSaleFlag(
                    ticker=ev.ticker, sell_trade_id=ev.sell_trade_id,
                    sell_date=ev.sell_date, loss=ev.realized_pnl,
                    triggering_buy_id=b.id, triggering_buy_date=b.date,
                    days_between=delta))
                break
    return flags


def tax_summary(trades: List[Trade], method: LotMethod = LotMethod.FIFO,
                wash_window: int = 30) -> TaxReport:
    """One-shot report: realized events by method plus wash-sale flags."""
    rep = compute_realized(trades, method=method)
    rep.wash_sales = detect_wash_sales(trades, window_days=wash_window)
    return rep
