"""Sector exposure analysis and concentration risk.

We carry a small built-in sector map for common large-cap tickers so the
feature works out-of-the-box. Callers may pass a custom mapping that
overrides or extends the defaults. Tickers without a known sector are
bucketed as ``Unknown`` and surface as a warning.

The Herfindahl Hirschman Index (HHI) is computed across sector weights to
quantify concentration. HHI ranges 0..1 (1 = single sector). We also flag
any sector exceeding a configurable cap (default 35% of market value) and
any single position exceeding a position cap (default 25%).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Mapping, Optional


# Conservative, hand-maintained map. Not a full security master.
DEFAULT_SECTOR_MAP: Dict[str, str] = {
    # Technology
    "AAPL": "Technology", "MSFT": "Technology", "GOOG": "Technology",
    "GOOGL": "Technology", "META": "Technology", "NVDA": "Technology",
    "AMD": "Technology", "INTC": "Technology", "ORCL": "Technology",
    "CRM": "Technology", "ADBE": "Technology", "AVGO": "Technology",
    "CSCO": "Technology", "IBM": "Technology", "QCOM": "Technology",
    "TXN": "Technology", "MU": "Technology", "PLTR": "Technology",
    # Consumer Discretionary
    "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary",
    "HD": "Consumer Discretionary", "NKE": "Consumer Discretionary",
    "MCD": "Consumer Discretionary", "SBUX": "Consumer Discretionary",
    "LOW": "Consumer Discretionary", "BKNG": "Consumer Discretionary",
    # Communication Services
    "NFLX": "Communication Services", "DIS": "Communication Services",
    "T": "Communication Services", "VZ": "Communication Services",
    "CMCSA": "Communication Services",
    # Financials
    "JPM": "Financials", "BAC": "Financials", "WFC": "Financials",
    "GS": "Financials", "MS": "Financials", "C": "Financials",
    "BLK": "Financials", "SCHW": "Financials", "AXP": "Financials",
    "V": "Financials", "MA": "Financials",
    # Health Care
    "JNJ": "Health Care", "PFE": "Health Care", "MRK": "Health Care",
    "ABBV": "Health Care", "LLY": "Health Care", "UNH": "Health Care",
    "TMO": "Health Care", "DHR": "Health Care", "ABT": "Health Care",
    # Industrials
    "BA": "Industrials", "CAT": "Industrials", "GE": "Industrials",
    "HON": "Industrials", "UPS": "Industrials", "RTX": "Industrials",
    "LMT": "Industrials", "DE": "Industrials",
    # Energy
    "XOM": "Energy", "CVX": "Energy", "COP": "Energy", "SLB": "Energy",
    "OXY": "Energy", "EOG": "Energy",
    # Consumer Staples
    "PG": "Consumer Staples", "KO": "Consumer Staples", "PEP": "Consumer Staples",
    "WMT": "Consumer Staples", "COST": "Consumer Staples", "CL": "Consumer Staples",
    # Utilities
    "NEE": "Utilities", "DUK": "Utilities", "SO": "Utilities",
    # Real Estate
    "AMT": "Real Estate", "PLD": "Real Estate", "EQIX": "Real Estate",
    "SPG": "Real Estate",
    # Materials
    "LIN": "Materials", "APD": "Materials", "FCX": "Materials",
    # Broad market ETFs
    "SPY": "Broad Market ETF", "VOO": "Broad Market ETF",
    "QQQ": "Broad Market ETF", "IWM": "Broad Market ETF",
    "VTI": "Broad Market ETF", "DIA": "Broad Market ETF",
}


@dataclass
class SectorExposure:
    sector: str
    market_value: float
    weight: float
    tickers: List[str]

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ConcentrationReport:
    total_market_value: float
    sectors: List[SectorExposure]
    hhi: float                       # 0..1, sector concentration
    effective_n_sectors: float       # 1/HHI when HHI > 0
    max_sector: Optional[str]
    max_sector_weight: float
    max_position: Optional[str]
    max_position_weight: float
    sector_cap: float
    position_cap: float
    breaches: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    unknown_tickers: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["sectors"] = [s.to_dict() for s in self.sectors]
        return d


def classify(ticker: str, overrides: Optional[Mapping[str, str]] = None) -> str:
    t = ticker.upper()
    if overrides and t in overrides:
        return overrides[t]
    return DEFAULT_SECTOR_MAP.get(t, "Unknown")


def sector_exposure(
    weights_by_ticker: Mapping[str, float],
    market_values: Optional[Mapping[str, float]] = None,
    overrides: Optional[Mapping[str, str]] = None,
    sector_cap: float = 0.35,
    position_cap: float = 0.25,
) -> ConcentrationReport:
    """Compute sector buckets, HHI, and concentration breaches.

    ``weights_by_ticker`` should sum to 1.0 across the invested portfolio.
    ``market_values`` is optional; when provided, dollar values are
    aggregated per sector. Weights drive all caps/HHI math.
    """
    if not weights_by_ticker:
        return ConcentrationReport(
            total_market_value=0.0, sectors=[], hhi=0.0,
            effective_n_sectors=0.0, max_sector=None, max_sector_weight=0.0,
            max_position=None, max_position_weight=0.0,
            sector_cap=sector_cap, position_cap=position_cap,
        )

    mv = dict(market_values or {})
    total_mv = float(sum(mv.values())) if mv else 0.0

    buckets: Dict[str, Dict] = {}
    unknown: List[str] = []
    for ticker, w in weights_by_ticker.items():
        sec = classify(ticker, overrides)
        if sec == "Unknown":
            unknown.append(ticker.upper())
        b = buckets.setdefault(sec, {"weight": 0.0, "mv": 0.0, "tickers": []})
        b["weight"] += float(w)
        b["mv"] += float(mv.get(ticker, 0.0))
        b["tickers"].append(ticker.upper())

    sectors: List[SectorExposure] = []
    hhi = 0.0
    max_sec = None
    max_sec_w = 0.0
    for sec, b in buckets.items():
        w = b["weight"]
        sectors.append(SectorExposure(
            sector=sec, market_value=b["mv"], weight=w,
            tickers=sorted(b["tickers"])))
        hhi += w * w
        if w > max_sec_w:
            max_sec_w = w
            max_sec = sec

    sectors.sort(key=lambda s: s.weight, reverse=True)

    max_pos = None
    max_pos_w = 0.0
    for t, w in weights_by_ticker.items():
        if w > max_pos_w:
            max_pos_w = float(w)
            max_pos = t.upper()

    breaches: List[str] = []
    warnings: List[str] = []
    for s in sectors:
        if s.weight > sector_cap:
            breaches.append(
                f"sector {s.sector} at {s.weight:.1%} exceeds cap {sector_cap:.0%}")
    if max_pos and max_pos_w > position_cap:
        breaches.append(
            f"position {max_pos} at {max_pos_w:.1%} exceeds cap {position_cap:.0%}")
    if unknown:
        warnings.append(
            f"{len(unknown)} ticker(s) unclassified: {', '.join(sorted(set(unknown)))}")
    if hhi > 0.5:
        warnings.append(
            f"high sector concentration: HHI={hhi:.2f} (>0.50)")

    eff_n = (1.0 / hhi) if hhi > 0 else 0.0
    return ConcentrationReport(
        total_market_value=total_mv,
        sectors=sectors,
        hhi=hhi,
        effective_n_sectors=eff_n,
        max_sector=max_sec,
        max_sector_weight=max_sec_w,
        max_position=max_pos,
        max_position_weight=max_pos_w,
        sector_cap=sector_cap,
        position_cap=position_cap,
        breaches=breaches,
        warnings=warnings,
        unknown_tickers=sorted(set(unknown)),
    )
