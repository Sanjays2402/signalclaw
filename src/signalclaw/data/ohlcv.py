from __future__ import annotations
from pathlib import Path
import pandas as pd

from ..config import get_settings
from ..logging_ import get_logger

log = get_logger(__name__)


def _path_for(ticker: str) -> Path:
    s = get_settings()
    return s.parquet_dir / f"ohlcv_{ticker.replace('/', '_')}.parquet"


def fetch_ohlcv(ticker: str, start: str | None = None, end: str | None = None,
                period: str = "2y", interval: str = "1d") -> pd.DataFrame:
    """Fetch OHLCV from yfinance. Returns dataframe indexed by date with columns
    open/high/low/close/volume."""
    import yfinance as yf
    log.info("ohlcv.fetch", ticker=ticker, start=start, end=end, period=period)
    if start:
        df = yf.download(ticker, start=start, end=end, interval=interval,
                         auto_adjust=True, progress=False, threads=False)
    else:
        df = yf.download(ticker, period=period, interval=interval,
                         auto_adjust=True, progress=False, threads=False)
    if df is None or df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    # yfinance may return MultiIndex columns
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df.rename(columns=str.lower)
    df.index = pd.to_datetime(df.index).tz_localize(None)
    df = df[["open", "high", "low", "close", "volume"]].dropna()
    return df


def save_ohlcv(ticker: str, df: pd.DataFrame) -> Path:
    p = _path_for(ticker)
    df.to_parquet(p)
    return p


def load_ohlcv(ticker: str) -> pd.DataFrame:
    p = _path_for(ticker)
    if not p.exists():
        return pd.DataFrame()
    return pd.read_parquet(p)


def refresh_universe(tickers: list[str], period: str = "2y") -> dict[str, int]:
    out = {}
    for t in tickers:
        try:
            df = fetch_ohlcv(t, period=period)
            if not df.empty:
                save_ohlcv(t, df)
            out[t] = len(df)
        except Exception as e:  # noqa
            log.warning("ohlcv.refresh.fail", ticker=t, err=str(e))
            out[t] = 0
    return out
