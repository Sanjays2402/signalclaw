"""Order routing simulator with VWAP / TWAP / POV child-order schedules.

Inputs are explicit intraday bars (no market data fetched). Each bar carries
a VWAP-like price and a share volume. The simulator:

* Splits a parent order into per-bar child slices according to the chosen
  schedule (TWAP = equal weight, VWAP = proportional to expected volume,
  POV = participation rate of realized volume).
* Caps each slice at ``max_participation`` of the bar's volume to avoid
  unrealistic prints (POV always respects its own rate, but TWAP/VWAP can
  also be capped if requested).
* Applies a per-share slippage that grows linearly with the slice's
  participation in the bar (``slippage_bps_per_pct_adv``), in addition to
  any fixed cost-model slippage.
* Returns a fill report with realized average price, total cost vs the
  arrival price and the schedule's benchmark (interval VWAP), and a
  shortfall breakdown.

Designed to plug behind ``risk.pretrade``: pretrade asks "should I take this
trade", execution asks "given that I am taking it, what will it cost to
work it through the day".
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import List, Sequence, Tuple


class ScheduleKind(str, Enum):
    TWAP = "twap"
    VWAP = "vwap"
    POV = "pov"


@dataclass(frozen=True)
class IntradayBar:
    """One time slice of the trading session.

    ``price`` is the bar's effective execution price (typically the bar
    VWAP). ``volume`` is total market share volume during the bar.
    """
    index: int
    price: float
    volume: int

    def __post_init__(self) -> None:
        if self.index < 0:
            raise ValueError("bar index must be >= 0")
        if not (self.price > 0):
            raise ValueError("bar price must be > 0")
        if self.volume < 0:
            raise ValueError("bar volume must be >= 0")


@dataclass(frozen=True)
class SessionVolumeCurve:
    """Expected share of session volume per bar; must sum to ~1.0."""
    weights: Tuple[float, ...]

    def __post_init__(self) -> None:
        if not self.weights:
            raise ValueError("weights cannot be empty")
        if any(w < 0 for w in self.weights):
            raise ValueError("weights must be non-negative")
        s = sum(self.weights)
        if not (0.999 <= s <= 1.001):
            raise ValueError(f"weights must sum to 1.0 (got {s:.4f})")

    def __len__(self) -> int:
        return len(self.weights)


def build_uniform_curve(n: int) -> SessionVolumeCurve:
    if n <= 0:
        raise ValueError("n must be > 0")
    w = 1.0 / n
    return SessionVolumeCurve(tuple(w for _ in range(n)))


def build_u_shape_curve(n: int, edge_weight: float = 2.0) -> SessionVolumeCurve:
    """Classic intraday U: heavy at open and close, light in the middle.

    ``edge_weight`` is the multiplier applied to the first and last bins
    relative to a uniform baseline. Result is normalized to sum to 1.
    """
    if n <= 0:
        raise ValueError("n must be > 0")
    if edge_weight <= 0:
        raise ValueError("edge_weight must be > 0")
    if n == 1:
        return SessionVolumeCurve((1.0,))
    raw: List[float] = []
    for i in range(n):
        # symmetric distance from the middle, normalized to [0, 1]
        d = abs((i - (n - 1) / 2.0)) / ((n - 1) / 2.0)
        raw.append(1.0 + (edge_weight - 1.0) * d)
    s = sum(raw)
    return SessionVolumeCurve(tuple(x / s for x in raw))


@dataclass
class ParentOrder:
    ticker: str
    side: str                   # "buy" or "sell"
    shares: int
    arrival_price: float        # decision-time mid, used as cost benchmark
    schedule: ScheduleKind = ScheduleKind.VWAP
    expected_curve: Tuple[float, ...] | None = None  # for VWAP only
    participation_rate: float = 0.10                 # POV rate of realized vol
    max_participation: float = 0.20                  # hard cap per bar
    base_slippage_bps: float = 1.0                   # always-on per-trade slip
    slippage_bps_per_pct_adv: float = 5.0            # extra slip per 1% ADV taken
    commission_per_share: float = 0.0

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).strip().upper()
        if not self.ticker:
            raise ValueError("ticker required")
        s = (self.side or "").lower()
        if s not in ("buy", "sell"):
            raise ValueError("side must be buy or sell")
        self.side = s
        if self.shares <= 0:
            raise ValueError("shares must be > 0")
        if not (self.arrival_price > 0):
            raise ValueError("arrival_price must be > 0")
        if not (0.0 < self.participation_rate <= 1.0):
            raise ValueError("participation_rate must be in (0, 1]")
        if not (0.0 < self.max_participation <= 1.0):
            raise ValueError("max_participation must be in (0, 1]")
        if self.participation_rate > self.max_participation:
            raise ValueError("participation_rate cannot exceed max_participation")
        if self.base_slippage_bps < 0 or self.slippage_bps_per_pct_adv < 0:
            raise ValueError("slippage bps must be non-negative")
        if self.commission_per_share < 0:
            raise ValueError("commission_per_share must be non-negative")
        if self.expected_curve is not None:
            curve = SessionVolumeCurve(tuple(self.expected_curve))
            self.expected_curve = curve.weights


@dataclass(frozen=True)
class ChildFill:
    bar_index: int
    shares: int
    fill_price: float
    market_price: float
    participation: float        # shares / bar_volume
    slippage_bps: float
    commission: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ExecutionReport:
    ticker: str
    side: str
    requested_shares: int
    filled_shares: int
    arrival_price: float
    avg_fill_price: float
    interval_vwap: float
    notional: float
    commission_total: float
    slippage_vs_arrival_bps: float
    slippage_vs_vwap_bps: float
    fills: Tuple[ChildFill, ...]

    @property
    def unfilled_shares(self) -> int:
        return self.requested_shares - self.filled_shares

    def to_dict(self) -> dict:
        d = asdict(self)
        d["fills"] = [f if isinstance(f, dict) else asdict(f) for f in self.fills]
        d["unfilled_shares"] = self.unfilled_shares
        return d


@dataclass(frozen=True)
class SliceSchedule:
    """The pre-trade plan: target shares per bar before participation caps."""
    target_shares: Tuple[int, ...]

    def __post_init__(self) -> None:
        if any(s < 0 for s in self.target_shares):
            raise ValueError("target_shares must be non-negative")


def _largest_remainder(weights: Sequence[float], total: int) -> List[int]:
    """Apportion ``total`` integers across ``weights`` using largest-remainder."""
    if total <= 0 or not weights:
        return [0 for _ in weights]
    raw = [w * total for w in weights]
    floors = [int(x) for x in raw]
    remainder = total - sum(floors)
    # distribute leftover units to the largest fractional parts, deterministically
    frac = sorted(
        range(len(weights)),
        key=lambda i: (raw[i] - floors[i], weights[i], -i),
        reverse=True,
    )
    for i in range(remainder):
        floors[frac[i % len(frac)]] += 1
    return floors


def _plan_targets(order: ParentOrder, bars: Sequence[IntradayBar]) -> List[int]:
    n = len(bars)
    if n == 0:
        return []
    if order.schedule is ScheduleKind.TWAP:
        weights = [1.0 / n] * n
        return _largest_remainder(weights, order.shares)
    if order.schedule is ScheduleKind.VWAP:
        curve = order.expected_curve
        if curve is None or len(curve) != n:
            curve = build_uniform_curve(n).weights
        return _largest_remainder(list(curve), order.shares)
    # POV: target is whatever participation_rate of expected/realized volume gives.
    # Use realized bar volume as the best proxy; cap is handled later.
    weights: List[float] = []
    total_vol = sum(b.volume for b in bars)
    if total_vol <= 0:
        return [0] * n
    for b in bars:
        weights.append(b.volume / total_vol)
    pov_total = min(order.shares, int(order.participation_rate * total_vol))
    return _largest_remainder(weights, pov_total)


def simulate_execution(
    order: ParentOrder, bars: Sequence[IntradayBar]
) -> ExecutionReport:
    """Run the schedule across ``bars`` and return a fill report."""
    if not bars:
        raise ValueError("bars must be non-empty")
    # bars must be ordered by index, contiguous from the first
    for i, b in enumerate(bars):
        if b.index != bars[0].index + i:
            raise ValueError("bars must be contiguous in index")
    targets = _plan_targets(order, bars)
    remaining = order.shares
    fills: List[ChildFill] = []
    side_sign = 1.0 if order.side == "buy" else -1.0
    for b, want in zip(bars, targets):
        if remaining <= 0:
            break
        if want <= 0:
            continue
        cap = int(b.volume * order.max_participation)
        take = min(want, cap, remaining)
        if take <= 0:
            continue
        participation = take / b.volume if b.volume > 0 else 0.0
        # slippage: base + linear in % ADV taken (pct expressed in [0, 1])
        slip_bps = order.base_slippage_bps + order.slippage_bps_per_pct_adv * (
            participation * 100.0
        )
        fill_price = b.price * (1.0 + side_sign * slip_bps / 10_000.0)
        commission = order.commission_per_share * take
        fills.append(
            ChildFill(
                bar_index=b.index,
                shares=take,
                fill_price=round(fill_price, 6),
                market_price=b.price,
                participation=round(participation, 6),
                slippage_bps=round(slip_bps, 4),
                commission=round(commission, 6),
            )
        )
        remaining -= take
    filled = sum(f.shares for f in fills)
    notional = sum(f.shares * f.fill_price for f in fills)
    avg_fill = notional / filled if filled > 0 else 0.0
    # interval VWAP across bars we actually traded in (weighted by market volume)
    traded_idx = {f.bar_index for f in fills}
    vol_num = 0.0
    vol_den = 0
    for b in bars:
        if b.index in traded_idx:
            vol_num += b.price * b.volume
            vol_den += b.volume
    interval_vwap = vol_num / vol_den if vol_den > 0 else order.arrival_price
    # cost in bps vs arrival and vs VWAP, signed so positive = adverse to trader
    def _bps(realized: float, bench: float) -> float:
        if bench <= 0 or filled == 0:
            return 0.0
        return side_sign * (realized - bench) / bench * 10_000.0
    return ExecutionReport(
        ticker=order.ticker,
        side=order.side,
        requested_shares=order.shares,
        filled_shares=filled,
        arrival_price=order.arrival_price,
        avg_fill_price=round(avg_fill, 6),
        interval_vwap=round(interval_vwap, 6),
        notional=round(notional, 6),
        commission_total=round(sum(f.commission for f in fills), 6),
        slippage_vs_arrival_bps=round(_bps(avg_fill, order.arrival_price), 4),
        slippage_vs_vwap_bps=round(_bps(avg_fill, interval_vwap), 4),
        fills=tuple(fills),
    )
