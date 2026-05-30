"""Pre-trade order simulator.

Differs from ``risk.sizing`` (Kelly + ATR sizing for raw picks) in that
this module models execution costs explicitly and supports portfolio-aware
checks (current exposure to the same ticker, total portfolio concentration
after the prospective fill). It is intended for the "I have a plan, can I
take it" check rather than picking what to trade.

Inputs are explicit numbers, not OHLCV frames, so the simulator runs in
constant time without any market-data dependency.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Mapping, Optional


VALID_SIDES = ("long", "short")


@dataclass
class CostModel:
    """All numbers are dollars per the named unit."""
    commission_per_trade: float = 0.0
    commission_per_share: float = 0.0
    slippage_bps: float = 0.0       # basis points of notional
    min_commission: float = 0.0

    def estimate(self, shares: int, price: float) -> float:
        if shares <= 0 or price <= 0:
            return 0.0
        notional = shares * price
        slip = notional * (self.slippage_bps / 10_000.0)
        comm = self.commission_per_trade + self.commission_per_share * shares
        comm = max(comm, self.min_commission)
        return float(comm + slip)


@dataclass
class OrderRequest:
    ticker: str
    side: str                       # long | short
    price: float
    stop: float
    target: float
    equity: float
    risk_per_trade: float = 0.01    # fraction of equity to risk at stop
    max_position_pct: float = 0.20  # max fraction of equity per single name
    min_shares: int = 1
    max_portfolio_pct: float = 1.0  # cap on (existing+new)/equity for this ticker
    cost: CostModel = field(default_factory=CostModel)
    existing_shares: int = 0        # current position size in this ticker
    existing_avg_price: float = 0.0

    def __post_init__(self) -> None:
        self.ticker = str(self.ticker).strip().upper()
        if not self.ticker:
            raise ValueError("ticker required")
        if self.side not in VALID_SIDES:
            raise ValueError(f"side must be one of {VALID_SIDES}")
        for name in ("price", "stop", "target", "equity"):
            v = getattr(self, name)
            if not isinstance(v, (int, float)) or v <= 0:
                raise ValueError(f"{name} must be > 0")
        for name in ("risk_per_trade", "max_position_pct", "max_portfolio_pct"):
            v = getattr(self, name)
            if not (0.0 < v <= 1.0):
                raise ValueError(f"{name} must be in (0, 1]")
        if self.min_shares < 1:
            raise ValueError("min_shares must be >= 1")
        if self.side == "long":
            if self.stop >= self.price:
                raise ValueError("long order requires stop < price")
            if self.target <= self.price:
                raise ValueError("long order requires target > price")
        else:
            if self.stop <= self.price:
                raise ValueError("short order requires stop > price")
            if self.target >= self.price:
                raise ValueError("short order requires target < price")
        if self.existing_shares < 0:
            raise ValueError("existing_shares must be >= 0")


@dataclass
class OrderSimulation:
    ticker: str
    side: str
    shares: int
    notional: float
    fees: float
    total_cost: float               # notional + fees (long) or notional - fees (short proceeds adjustment)
    risk_per_share: float
    reward_per_share: float
    planned_r_multiple: float
    planned_risk_dollars: float
    planned_reward_dollars: float
    weight: float                   # notional / equity
    post_trade_ticker_pct: float    # (existing + new) notional / equity
    cap_reason: str                 # binding constraint
    accepted: bool
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict:
        return asdict(self)


def simulate_order(req: OrderRequest) -> OrderSimulation:
    """Return an OrderSimulation for ``req``.

    The simulator picks the largest share count that respects:
      - risk_per_trade * equity  >=  shares * risk_per_share + estimated fees
      - shares * price           <=  max_position_pct * equity
      - (existing + shares) * price <= max_portfolio_pct * equity
    and reports which constraint was binding. If the resulting share count
    is below min_shares, the simulation is marked rejected.
    """
    warnings: List[str] = []

    risk_per_share = abs(req.price - req.stop)
    reward_per_share = abs(req.target - req.price)
    if risk_per_share <= 0:
        return OrderSimulation(
            ticker=req.ticker, side=req.side, shares=0,
            notional=0.0, fees=0.0, total_cost=0.0,
            risk_per_share=0.0, reward_per_share=reward_per_share,
            planned_r_multiple=0.0,
            planned_risk_dollars=0.0, planned_reward_dollars=0.0,
            weight=0.0, post_trade_ticker_pct=0.0,
            cap_reason="no_stop_distance", accepted=False,
            warnings=["stop equals price; cannot size"],
        )

    risk_budget = req.equity * req.risk_per_trade

    # Iterate down from the risk-only cap, adjusting for fees.
    fee_estimate = req.cost.estimate(1, req.price)
    shares_by_risk = max(0, int((risk_budget - fee_estimate) // risk_per_share))
    if shares_by_risk <= 0:
        shares_by_risk = 0
    else:
        # refine by recomputing fees at the candidate share count
        fee_at = req.cost.estimate(shares_by_risk, req.price)
        while shares_by_risk > 0 and (
            shares_by_risk * risk_per_share + fee_at > risk_budget
        ):
            shares_by_risk -= 1
            fee_at = req.cost.estimate(shares_by_risk, req.price)

    max_position_dollars = req.equity * req.max_position_pct
    shares_by_weight = int(max_position_dollars // req.price)

    portfolio_cap_dollars = req.equity * req.max_portfolio_pct
    existing_dollars = req.existing_shares * req.price  # mark-to-market on entry price
    headroom_dollars = max(0.0, portfolio_cap_dollars - existing_dollars)
    shares_by_portfolio = int(headroom_dollars // req.price)

    caps = [
        (shares_by_risk, "risk_per_trade"),
        (shares_by_weight, "max_position_pct"),
        (shares_by_portfolio, "max_portfolio_pct"),
    ]
    shares, cap_reason = min(caps, key=lambda x: x[0])

    if shares < req.min_shares:
        accepted = False
        warnings.append(
            f"binding={cap_reason}; shares={shares} below min_shares={req.min_shares}"
        )
        shares = 0
        notional = 0.0
        fees = 0.0
        planned_risk = 0.0
        planned_reward = 0.0
    else:
        accepted = True
        notional = float(shares * req.price)
        fees = req.cost.estimate(shares, req.price)
        planned_risk = shares * risk_per_share + fees
        planned_reward = shares * reward_per_share - fees
        if planned_risk > risk_budget * 1.001:
            warnings.append("fees pushed planned risk above risk_per_trade budget")
        if req.existing_shares > 0 and req.side == "long":
            avg_breach = req.existing_avg_price > req.price * 1.10
            if avg_breach:
                warnings.append(
                    "averaging down more than 10% below prior average price"
                )

    weight = notional / req.equity if req.equity > 0 else 0.0
    post_trade_ticker_dollars = existing_dollars + notional
    post_trade_pct = post_trade_ticker_dollars / req.equity if req.equity > 0 else 0.0

    return OrderSimulation(
        ticker=req.ticker,
        side=req.side,
        shares=shares,
        notional=round(notional, 4),
        fees=round(fees, 4),
        total_cost=round(notional + fees if req.side == "long" else notional - fees, 4),
        risk_per_share=round(risk_per_share, 6),
        reward_per_share=round(reward_per_share, 6),
        planned_r_multiple=round(reward_per_share / risk_per_share, 4) if risk_per_share > 0 else 0.0,
        planned_risk_dollars=round(planned_risk, 4),
        planned_reward_dollars=round(planned_reward, 4),
        weight=round(weight, 6),
        post_trade_ticker_pct=round(post_trade_pct, 6),
        cap_reason=cap_reason,
        accepted=accepted,
        warnings=warnings,
    )
