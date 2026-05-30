"""FX rates: cached daily USD-quoted exchange rates with point-in-time lookup.

Stores per-currency series of USD-per-unit rates in a parquet file under
data/fx/<CCY>.parquet (one row per date). Lookups return the most recent
rate on or before the requested date. A pluggable fetcher allows tests and
offline use; default fetcher uses yfinance pair tickers (CCYUSD=X) when
available.

A FX-aware snapshot helper rebuilds the portfolio snapshot in a base
currency by converting each trade's native price + cash flow at the trade
date's FX rate. Currencies recorded per-trade live in a side-car JSON so the
existing Trade dataclass stays unchanged.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional
import json
import threading

import pandas as pd

USD = "USD"


@dataclass(frozen=True)
class FxRate:
    currency: str
    date: str  # ISO date
    rate: float  # USD per 1 unit of `currency` (e.g. EUR=1.10 means 1 EUR = 1.10 USD)


class FxStore:
    """Parquet-per-currency cache with point-in-time `as_of` lookups."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, currency: str) -> Path:
        return self.root / f"{currency.upper()}.parquet"

    def has(self, currency: str) -> bool:
        return currency.upper() == USD or self._path(currency).exists()

    def load(self, currency: str) -> pd.DataFrame:
        if currency.upper() == USD:
            return pd.DataFrame()
        p = self._path(currency)
        if not p.exists():
            return pd.DataFrame()
        df = pd.read_parquet(p)
        df.index = pd.to_datetime(df.index).normalize()
        df = df[~df.index.duplicated(keep="last")].sort_index()
        return df

    def save(self, currency: str, rates: pd.DataFrame) -> None:
        if currency.upper() == USD:
            return
        if rates is None or rates.empty or "rate" not in rates.columns:
            raise ValueError("rates must be non-empty DataFrame with 'rate' column")
        with self._lock:
            existing = self.load(currency)
            df = pd.concat([existing, rates]) if not existing.empty else rates.copy()
            df.index = pd.to_datetime(df.index).normalize()
            df = df[~df.index.duplicated(keep="last")].sort_index()
            df.to_parquet(self._path(currency))

    def upsert_rate(self, currency: str, as_of: str, rate: float) -> None:
        df = pd.DataFrame({"rate": [float(rate)]},
                          index=pd.to_datetime([as_of]).normalize())
        self.save(currency, df)

    def get(self, currency: str, as_of: str) -> Optional[float]:
        """Return USD-per-unit rate on or before as_of, or None if missing."""
        if currency.upper() == USD:
            return 1.0
        df = self.load(currency)
        if df.empty:
            return None
        ts = pd.Timestamp(as_of).normalize()
        sub = df.loc[df.index <= ts]
        if sub.empty:
            return None
        return float(sub["rate"].iloc[-1])

    def currencies(self) -> List[str]:
        return sorted(p.stem.upper() for p in self.root.glob("*.parquet"))


# --- Fetcher protocol -----------------------------------------------------

FxFetcher = Callable[[str, str, str], pd.DataFrame]
"""(currency, start_iso, end_iso) -> DataFrame indexed by date with 'rate' col."""


def yfinance_fx_fetcher(currency: str, start: str, end: str) -> pd.DataFrame:
    """Fetch USD-per-unit daily close from Yahoo using `<CCY>USD=X` ticker.

    Returns empty DataFrame on failure (network, missing pair, etc.).
    """
    if currency.upper() == USD:
        return pd.DataFrame()
    try:
        import yfinance as yf  # type: ignore
    except Exception:  # pragma: no cover
        return pd.DataFrame()
    pair = f"{currency.upper()}USD=X"
    try:
        df = yf.download(pair, start=start, end=end, progress=False,
                          auto_adjust=False, threads=False)
    except Exception:  # pragma: no cover
        return pd.DataFrame()
    if df is None or df.empty or "Close" not in df.columns:
        return pd.DataFrame()
    out = pd.DataFrame({"rate": df["Close"].astype(float).values},
                       index=pd.to_datetime(df.index).normalize())
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out


def refresh_currency(
    store: FxStore,
    currency: str,
    start: str,
    end: str,
    fetcher: FxFetcher = yfinance_fx_fetcher,
) -> int:
    """Fetch fresh rates and merge into store. Returns rows written."""
    if currency.upper() == USD:
        return 0
    df = fetcher(currency, start, end)
    if df is None or df.empty:
        return 0
    store.save(currency, df)
    return int(len(df))


# --- Currency assignments side-car ---------------------------------------

class TradeCurrencyMap:
    """JSON side-car: trade_id -> ISO-4217 currency.

    Trades without an entry are assumed USD.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"trades": {}}, indent=2))

    def _read(self) -> Dict[str, str]:
        raw = json.loads(self.path.read_text() or '{"trades":{}}')
        return {k: str(v).upper() for k, v in (raw.get("trades") or {}).items()}

    def _write(self, m: Dict[str, str]) -> None:
        self.path.write_text(json.dumps({"trades": m}, indent=2, sort_keys=True))

    def get(self, trade_id: str) -> str:
        return self._read().get(trade_id, USD)

    def set(self, trade_id: str, currency: str) -> None:
        cur = currency.upper().strip()
        if len(cur) != 3 or not cur.isalpha():
            raise ValueError("currency must be a 3-letter ISO code")
        with self._lock:
            m = self._read()
            m[trade_id] = cur
            self._write(m)

    def remove(self, trade_id: str) -> bool:
        with self._lock:
            m = self._read()
            if trade_id not in m:
                return False
            del m[trade_id]
            self._write(m)
        return True

    def all(self) -> Dict[str, str]:
        return self._read()

    def clear(self) -> None:
        with self._lock:
            self._write({})


# --- Conversion helpers ---------------------------------------------------

@dataclass
class ConversionAudit:
    trade_id: str
    native_currency: str
    native_amount: float
    rate: Optional[float]
    base_amount: Optional[float]
    rate_date: Optional[str]  # date the rate came from (<= trade date)
    fallback: bool  # True if rate was missing and we used 1.0

    def to_dict(self) -> dict:
        return {
            "trade_id": self.trade_id,
            "native_currency": self.native_currency,
            "native_amount": self.native_amount,
            "rate": self.rate,
            "base_amount": self.base_amount,
            "rate_date": self.rate_date,
            "fallback": self.fallback,
        }


def convert_trade_amount(
    trade_id: str,
    amount: float,
    currency: str,
    as_of: str,
    fx: FxStore,
    base: str = USD,
) -> ConversionAudit:
    """Convert `amount` from `currency` to `base` using point-in-time FX.

    Currently supports base=USD only; cross-currency goes through USD.
    """
    base = base.upper()
    src = currency.upper()
    if base != USD:
        raise NotImplementedError("only USD base currency supported")
    if src == USD:
        return ConversionAudit(trade_id=trade_id, native_currency=src,
                               native_amount=amount, rate=1.0,
                               base_amount=amount, rate_date=as_of,
                               fallback=False)
    rate = fx.get(src, as_of)
    if rate is None:
        return ConversionAudit(trade_id=trade_id, native_currency=src,
                               native_amount=amount, rate=None,
                               base_amount=None, rate_date=None, fallback=True)
    # Find actual rate date used
    df = fx.load(src)
    rate_date = None
    if not df.empty:
        ts = pd.Timestamp(as_of).normalize()
        sub = df.loc[df.index <= ts]
        if not sub.empty:
            rate_date = str(sub.index[-1].date())
    return ConversionAudit(trade_id=trade_id, native_currency=src,
                           native_amount=amount, rate=rate,
                           base_amount=amount * rate, rate_date=rate_date,
                           fallback=False)


def convert_trades(
    trades: Iterable["object"],  # iterable of Trade
    currency_map: TradeCurrencyMap,
    fx: FxStore,
    base: str = USD,
) -> Dict[str, ConversionAudit]:
    """Build {trade_id -> ConversionAudit} for the cash leg of each trade.

    The cash amount equals trade.quantity * trade.price (sign-agnostic; this
    function just converts notional). Fees are not converted here.
    """
    out: Dict[str, ConversionAudit] = {}
    for tr in trades:
        cur = currency_map.get(tr.id)
        amount = float(tr.quantity) * float(tr.price)
        out[tr.id] = convert_trade_amount(tr.id, amount, cur, tr.date, fx,
                                            base=base)
    return out


__all__ = [
    "USD",
    "FxRate",
    "FxStore",
    "FxFetcher",
    "yfinance_fx_fetcher",
    "refresh_currency",
    "TradeCurrencyMap",
    "ConversionAudit",
    "convert_trade_amount",
    "convert_trades",
]
