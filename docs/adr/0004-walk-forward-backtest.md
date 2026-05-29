# ADR 0004: Walk-forward backtest

Decision: rolling train window (252 days), step 21, horizon 5. No look-ahead. Transaction costs modeled at 1 bp commission + 5 bp slippage. Long-only when score > 0.2.
