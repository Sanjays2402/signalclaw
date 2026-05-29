from __future__ import annotations
import pandas as pd


def rolling_sentiment(scores: pd.Series, window: int = 5) -> pd.Series:
    if scores.empty:
        return scores
    return scores.rolling(window, min_periods=1).mean()
