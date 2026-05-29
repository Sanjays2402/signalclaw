from __future__ import annotations
import pandas as pd


def rationale_for(ticker: str, features_row: pd.Series, prediction) -> str:
    parts: list[str] = []
    rsi = features_row.get("rsi14", 50)
    if rsi < 35:
        parts.append(f"RSI {rsi:.0f} oversold")
    elif rsi > 65:
        parts.append(f"RSI {rsi:.0f} overbought")
    macd_h = features_row.get("macd_hist", 0)
    if macd_h > 0:
        parts.append("MACD histogram positive")
    elif macd_h < 0:
        parts.append("MACD histogram negative")
    bb = features_row.get("bb_pct", 0.5)
    if bb < 0.1:
        parts.append("price near lower band")
    elif bb > 0.9:
        parts.append("price near upper band")
    sma_ratio = features_row.get("sma_20_50_ratio", 1.0)
    if sma_ratio > 1.02:
        parts.append("SMA20 above SMA50 (breakout)")
    elif sma_ratio < 0.98:
        parts.append("SMA20 below SMA50 (breakdown)")
    sent = features_row.get("sentiment_5d", 0)
    if sent > 0.2:
        parts.append("bullish news sentiment")
    elif sent < -0.2:
        parts.append("bearish news sentiment")
    vr = features_row.get("vol_regime", 0)
    if vr == 1:
        parts.append("high-vol regime")
    elif vr == -1:
        parts.append("low-vol regime")
    parts.append(f"model expected 5d return {prediction.expected_return * 100:+.2f}%")
    parts.append(f"composite score {prediction.score:+.2f}")
    return f"{ticker}: " + " + ".join(parts)


def risk_flags(features_row: pd.Series) -> list[str]:
    flags: list[str] = []
    if features_row.get("vol_20", 0) > 0.6:
        flags.append("HIGH_VOL")
    if features_row.get("atr14", 0) and features_row.get("atr14") > features_row.get("vol_20", 0) * 2:
        flags.append("ATR_SPIKE")
    if features_row.get("bb_width", 0) > 0.3:
        flags.append("WIDE_BANDS")
    if abs(features_row.get("ret_1", 0)) > 0.08:
        flags.append("SINGLE_DAY_MOVE_GT_8PCT")
    return flags
