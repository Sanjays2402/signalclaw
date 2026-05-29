export default function About() {
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-xl mb-3">About SignalClaw</h1>
      <p className="muted text-sm">A personal research tool for stock and crypto signals. Built on yfinance OHLCV, RSS news sentiment scored by FinBERT, technical indicators, and a small ensemble of LightGBM, XGBoost, and an LSTM baseline.</p>
      <p className="mt-4 text-[var(--amber)]"><strong>NOT FINANCIAL ADVICE.</strong></p>
      <p className="muted text-xs mt-2">See FINANCIAL_DISCLAIMER.md in the repo.</p>
    </div>
  );
}
