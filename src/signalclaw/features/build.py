from __future__ import annotations
import pandas as pd
from .technical import rsi, macd, bollinger_bands, atr, obv, sma, ema
from .returns import simple_returns, rolling_volatility, volatility_regime

FEATURE_COLUMNS = [
    "rsi14", "macd", "macd_signal", "macd_hist",
    "bb_pct", "bb_width", "atr14", "obv_z",
    "ret_1", "ret_5", "ret_20", "vol_20",
    "sma_20_50_ratio", "ema_12_26_ratio", "vol_regime",
    "sentiment_5d",
]


def build_features(df: pd.DataFrame, sentiment: pd.Series | None = None) -> pd.DataFrame:
    if df.empty or len(df) < 60:
        return pd.DataFrame()
    out = pd.DataFrame(index=df.index)
    close = df["close"]
    out["rsi14"] = rsi(close, 14)
    m = macd(close)
    out["macd"] = m["macd"]
    out["macd_signal"] = m["macd_signal"]
    out["macd_hist"] = m["macd_hist"]
    bb = bollinger_bands(close)
    out["bb_pct"] = bb["bb_pct"]
    out["bb_width"] = bb["bb_width"]
    out["atr14"] = atr(df["high"], df["low"], close, 14)
    obv_s = obv(close, df["volume"])
    out["obv_z"] = (obv_s - obv_s.rolling(60, min_periods=20).mean()) / obv_s.rolling(60, min_periods=20).std()
    out["ret_1"] = simple_returns(close, 1)
    out["ret_5"] = simple_returns(close, 5)
    out["ret_20"] = simple_returns(close, 20)
    vol = rolling_volatility(close, 20)
    out["vol_20"] = vol
    out["sma_20_50_ratio"] = sma(close, 20) / sma(close, 50)
    out["ema_12_26_ratio"] = ema(close, 12) / ema(close, 26)
    out["vol_regime"] = volatility_regime(vol)
    if sentiment is not None and not sentiment.empty:
        s = sentiment.reindex(out.index).ffill().fillna(0.0)
        out["sentiment_5d"] = s.rolling(5, min_periods=1).mean()
    else:
        out["sentiment_5d"] = 0.0
    return out
