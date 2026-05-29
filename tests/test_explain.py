import pandas as pd
from signalclaw.explain import rationale_for, risk_flags
from dataclasses import dataclass


@dataclass
class P:
    score: float = 0.4
    expected_return: float = 0.02


def test_rationale_contains_ticker():
    row = pd.Series({"rsi14": 30, "macd_hist": 0.1, "bb_pct": 0.05, "sma_20_50_ratio": 1.03,
                     "sentiment_5d": 0.3, "vol_regime": 1, "vol_20": 0.4, "atr14": 1.0, "ret_1": 0.01,
                     "bb_width": 0.2})
    out = rationale_for("MSFT", row, P())
    assert "MSFT" in out
    flags = risk_flags(row)
    assert isinstance(flags, list)
