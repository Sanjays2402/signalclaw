# Indicator: rsi

Used in SignalClaw feature pipeline. See `src/signalclaw/features/` for the implementation.

Inputs: OHLCV. Output column: `rsi`. Window sizes follow standard practice (14/20/50/200 where applicable).

This is technical analysis, not advice. Indicator signals fail in regime shifts; combine with model output and risk flags.
