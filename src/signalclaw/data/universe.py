from __future__ import annotations
import json
from pathlib import Path
from typing import List

# Default watchlist seeded from Sanjay's known holdings (memory/MEMORY.md):
# BTC, SOXX, MSFT, FXAIX, TSLA, SPY.
# yfinance uses BTC-USD for spot bitcoin; FXAIX is the Fidelity 500 mutual fund.
DEFAULT_WATCHLIST: List[str] = ["BTC-USD", "SOXX", "MSFT", "FXAIX", "TSLA", "SPY"]


def default_watchlist() -> List[str]:
    return list(DEFAULT_WATCHLIST)


class WatchlistStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.path.write_text(json.dumps({"tickers": default_watchlist()}, indent=2))

    def list(self) -> List[str]:
        return json.loads(self.path.read_text()).get("tickers", [])

    def add(self, ticker: str) -> List[str]:
        ts = self.list()
        t = ticker.upper().strip()
        if t and t not in ts:
            ts.append(t)
            self.path.write_text(json.dumps({"tickers": ts}, indent=2))
        return ts

    def remove(self, ticker: str) -> List[str]:
        ts = [t for t in self.list() if t.upper() != ticker.upper()]
        self.path.write_text(json.dumps({"tickers": ts}, indent=2))
        return ts
