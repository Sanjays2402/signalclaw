"""Cash and margin ledger.

Tracks a single trading account through deposits, withdrawals, trades,
dividends, and daily margin-interest accrual. Computes Reg-T style buying
power (50% initial requirement, 25% maintenance) on a per-position basis
and flags margin calls when equity falls below maintenance requirements.

Pure functions over a small JSON-backed store. No market data fetched.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Dict, List, Mapping, Optional
import json
import threading


class EntryKind(str, Enum):
    DEPOSIT = "deposit"
    WITHDRAW = "withdraw"
    BUY = "buy"
    SELL = "sell"
    DIVIDEND = "dividend"
    INTEREST = "interest"
    FEE = "fee"


@dataclass(frozen=True)
class LedgerEntry:
    ts: str                      # ISO date or datetime, opaque to ledger
    kind: EntryKind
    amount: float                # signed cash delta (positive = cash in)
    ticker: Optional[str] = None
    shares: int = 0              # signed share delta on the position
    price: float = 0.0
    note: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d

    @staticmethod
    def from_dict(d: Mapping) -> "LedgerEntry":
        return LedgerEntry(
            ts=str(d["ts"]),
            kind=EntryKind(d["kind"]),
            amount=float(d["amount"]),
            ticker=(str(d["ticker"]) if d.get("ticker") else None),
            shares=int(d.get("shares", 0) or 0),
            price=float(d.get("price", 0.0) or 0.0),
            note=str(d.get("note", "")),
        )


@dataclass
class MarginConfig:
    """Reg-T defaults; can be tightened by the user."""
    initial_margin: float = 0.50      # fraction of long market value
    maintenance_margin: float = 0.25  # fraction below which a call is issued
    annual_interest_rate: float = 0.0825  # 8.25% on debit balances
    # 30/360 day-count for daily accrual: rate / 360 per day on negative cash.

    def __post_init__(self) -> None:
        for n in ("initial_margin", "maintenance_margin"):
            v = getattr(self, n)
            if not (0.0 < v < 1.0):
                raise ValueError(f"{n} must be in (0, 1)")
        if self.maintenance_margin > self.initial_margin:
            raise ValueError("maintenance_margin cannot exceed initial_margin")
        if self.annual_interest_rate < 0:
            raise ValueError("annual_interest_rate must be >= 0")


@dataclass
class AccountState:
    cash: float
    positions: Dict[str, int]              # ticker -> signed share qty
    cost_basis: Dict[str, float]           # ticker -> total $ paid (long only)
    config: MarginConfig

    @property
    def long_market_value(self) -> float:
        # Without marks we use cost basis as a conservative proxy. Callers
        # that have marks should call ``snapshot_with_marks``.
        return float(sum(v for v in self.cost_basis.values() if v > 0))


@dataclass(frozen=True)
class AccountSnapshot:
    cash: float
    long_market_value: float
    short_market_value: float
    equity: float                  # cash + LMV - |SMV|
    margin_used: float             # debit balance = max(0, -cash)
    initial_requirement: float
    maintenance_requirement: float
    buying_power: float            # how much new LMV can be added
    excess_liquidity: float        # equity - maintenance_requirement
    margin_call: bool
    margin_call_amount: float      # 0 if not called, else amount to deposit

    def to_dict(self) -> dict:
        return asdict(self)


def _market_value(positions: Mapping[str, int], marks: Mapping[str, float]
                  ) -> tuple[float, float]:
    lmv = 0.0
    smv = 0.0
    for t, q in positions.items():
        p = float(marks.get(t, 0.0))
        if p <= 0:
            continue
        if q > 0:
            lmv += q * p
        elif q < 0:
            smv += q * p   # negative
    return lmv, smv


def snapshot(state: AccountState, marks: Optional[Mapping[str, float]] = None
             ) -> AccountSnapshot:
    cfg = state.config
    marks = marks or {}
    lmv, smv = _market_value(state.positions, marks)
    # for tickers without a mark, fall back to average cost basis for longs
    if marks is not None:
        for t, q in state.positions.items():
            if q > 0 and float(marks.get(t, 0.0)) <= 0:
                basis = state.cost_basis.get(t, 0.0)
                lmv += basis
    equity = state.cash + lmv + smv     # smv is negative
    margin_used = max(0.0, -state.cash)
    abs_smv = -smv
    init_req = cfg.initial_margin * lmv + cfg.initial_margin * abs_smv
    maint_req = cfg.maintenance_margin * lmv + cfg.maintenance_margin * abs_smv
    # buying power: incremental long position you could add today
    # equity must cover initial margin of (existing + new) LMV
    buying_power = max(0.0, equity / cfg.initial_margin - lmv)
    excess = equity - maint_req
    call = excess < 0
    call_amt = -excess if call else 0.0
    return AccountSnapshot(
        cash=round(state.cash, 6),
        long_market_value=round(lmv, 6),
        short_market_value=round(smv, 6),
        equity=round(equity, 6),
        margin_used=round(margin_used, 6),
        initial_requirement=round(init_req, 6),
        maintenance_requirement=round(maint_req, 6),
        buying_power=round(buying_power, 6),
        excess_liquidity=round(excess, 6),
        margin_call=call,
        margin_call_amount=round(call_amt, 6),
    )


def apply_entry(state: AccountState, entry: LedgerEntry) -> AccountState:
    """Return a new state with the entry applied. Pure: input is not mutated."""
    cash = state.cash + entry.amount
    positions = dict(state.positions)
    cost = dict(state.cost_basis)
    if entry.kind in (EntryKind.BUY, EntryKind.SELL) and entry.ticker:
        t = entry.ticker.upper()
        prior = positions.get(t, 0)
        positions[t] = prior + entry.shares
        # maintain cost basis only for the long side, average-cost
        if entry.kind is EntryKind.BUY and entry.shares > 0:
            cost[t] = cost.get(t, 0.0) + entry.shares * entry.price
        elif entry.kind is EntryKind.SELL and entry.shares < 0:
            # remove proportional cost basis
            sold = -entry.shares
            held = prior
            if held > 0:
                basis = cost.get(t, 0.0)
                avg = basis / held
                cost[t] = max(0.0, basis - avg * sold)
                if positions[t] <= 0:
                    cost.pop(t, None)
    return AccountState(
        cash=round(cash, 6),
        positions={k: v for k, v in positions.items() if v != 0},
        cost_basis=cost,
        config=state.config,
    )


def accrue_daily_interest(state: AccountState, days: int = 1) -> tuple[AccountState, float]:
    """Charge daily margin interest on any debit cash balance. Returns
    the new state and the dollar amount charged (positive)."""
    if days <= 0:
        return state, 0.0
    debit = max(0.0, -state.cash)
    if debit <= 0:
        return state, 0.0
    daily = state.config.annual_interest_rate / 360.0
    charge = debit * daily * days
    new_state = apply_entry(state, LedgerEntry(
        ts=f"+{days}d", kind=EntryKind.INTEREST,
        amount=-charge, note=f"margin interest, {days} day(s)",
    ))
    return new_state, round(charge, 6)


class LedgerStore:
    """JSON-backed append-only ledger keyed by account name."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"accounts": {}}))

    def _read(self) -> dict:
        return json.loads(self.path.read_text() or '{"accounts": {}}')

    def _write(self, data: dict) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def entries(self, account: str) -> List[LedgerEntry]:
        data = self._read()
        raw = data.get("accounts", {}).get(account, {}).get("entries", [])
        return [LedgerEntry.from_dict(d) for d in raw]

    def config(self, account: str) -> MarginConfig:
        data = self._read()
        cfg = data.get("accounts", {}).get(account, {}).get("config", {})
        return MarginConfig(**cfg) if cfg else MarginConfig()

    def set_config(self, account: str, cfg: MarginConfig) -> None:
        with self._lock:
            data = self._read()
            acct = data.setdefault("accounts", {}).setdefault(account, {})
            acct["config"] = {
                "initial_margin": cfg.initial_margin,
                "maintenance_margin": cfg.maintenance_margin,
                "annual_interest_rate": cfg.annual_interest_rate,
            }
            self._write(data)

    def append(self, account: str, entry: LedgerEntry) -> None:
        with self._lock:
            data = self._read()
            acct = data.setdefault("accounts", {}).setdefault(account, {})
            acct.setdefault("entries", []).append(entry.to_dict())
            self._write(data)

    def state(self, account: str) -> AccountState:
        cfg = self.config(account)
        state = AccountState(cash=0.0, positions={}, cost_basis={}, config=cfg)
        for e in self.entries(account):
            state = apply_entry(state, e)
        return state
