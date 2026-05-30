# SignalClaw

Personal stock and crypto signal bot. Ingests OHLCV from yfinance plus news sentiment, runs a small ML ensemble (LightGBM 3-class classifier, XGBoost regressor, LSTM baseline), and produces daily watch / hold / skip recommendations with rationale.

> **NOT FINANCIAL ADVICE.** See [FINANCIAL_DISCLAIMER.md](FINANCIAL_DISCLAIMER.md).

## Architecture

```
                +---------------------+
                |   yfinance OHLCV    |
                +----------+----------+
                           |
   RSS / NewsAPI -----+    v
                      v  parquet store
                +---------------------+
                |  features (RSI,     |
                |  MACD, BB, ATR,     |
                |  OBV, returns,      |
                |  vol regime, sent)  |
                +----------+----------+
                           v
                +---------------------+
                | ensemble:           |
                | LightGBM clf +      |
                | XGBoost reg +       |
                | LSTM baseline       |
                +----------+----------+
                           v
                +---------------------+
                | ranking + rationale |
                +----+-----+----------+
                     |     |
              markdown    FastAPI :7431 <----> Next.js dashboard :7430
                     |
                Telegram / Discord (opt-in)
```

## Dogfood

```bash
git clone https://github.com/Sanjays2402/signalclaw && cd signalclaw
python3 -m venv .venv && source .venv/bin/activate
pip install -e .
signalclaw ingest --period 3y
signalclaw run --today --out today.md
signalclaw backtest --ticker SPY --from 2024-01-01
signalclaw serve   # then open web/ with `cd web && npm install && npm run dev`
```

API auth via `SIGNALCLAW_API_KEY` header `x-api-key`. Dashboard auth via the same key entered at the unlock screen.

## Default watchlist

Seeded from `MEMORY.md`: BTC-USD, SOXX, MSFT, FXAIX, TSLA, SPY.

## Features (real, not stubs)

- yfinance OHLCV with parquet cache
- RSS news fetcher (Yahoo, SeekingAlpha) plus optional NewsAPI
- FinBERT sentiment scorer with disk cache and lexicon fallback
- Technical indicators: RSI, MACD, Bollinger Bands, ATR, OBV, SMA, EMA, rolling volatility, regime label, sentiment 5d
- Walk-forward backtest with transaction costs (commission + slippage bps), Sharpe / Sortino / max drawdown / hit rate / CAGR
- LightGBM 3-class classifier (watch / hold / skip), XGBoost forward-return regressor, tiny PyTorch LSTM directional baseline, weighted ensemble
- Markdown daily report with rationale and risk flags
- Telegram + Discord notifiers (disabled by default; print sample payload to logs)
- FastAPI on `:7431` with API key, CORS, structlog JSON, OTel scaffold
- Next.js 15 + Tailwind v4 dashboard with watchlist CRUD, today picks, equity curve, sparklines
- Alerts engine: price above/below, 1-day percent change, RSI cross, signal-label match, with per-alert cooldown, JSON-persisted store, CLI + REST + notifier dispatch
- Portfolio tracking: trades with FIFO cost basis, realized + unrealized P&L, CSV import / export, position weights, REST + CLI
- Position sizing: ATR-based stop and target, fractional Kelly with hard cap, risk-per-trade and max-position-percent constraints, binding-constraint reporting
- Correlation and diversification: pairwise correlation matrix on aligned log returns, single-linkage cluster grouping, warnings for high average correlation, single-name concentration, and cluster concentration
- Report history: daily reports auto-archived to data/reports, CLI + REST to list summaries, fetch any past report, and diff against a prior date (new/dropped/upgraded/downgraded picks and top score movers)


## Enterprise scaffolding

- `pyproject.toml` (uv-friendly), pydantic-settings, structlog JSON, OpenTelemetry scaffold
- Dockerfiles for api and web, `docker-compose.dev.yml`
- Helm chart in `infra/helm/signalclaw` plus per-env values
- Terraform skeleton in `infra/terraform` plus per-env modules
- GitHub Actions in `.github/workflows/ci.yml` gated by repo variable `ENABLE_CI` (default off, billing)
- pytest + hypothesis tests

## Repo layout

```
src/signalclaw/   core python package
  config/         pydantic-settings
  logging_/       structlog json
  data/           yfinance, news, parquet store, watchlist
  features/       technical indicators, returns, sentiment feature
  sentiment/      FinBERT scorer with cache
  models/         lightgbm + xgboost + lstm + ensemble
  backtest/       walk-forward engine, metrics, costs
  explain/        rationale strings, risk flags
  engine/         daily pipeline + markdown report
  notifier/       telegram + discord
  api/            FastAPI app
  cli/            click commands
services/         per-service entrypoints
packages/         universes, playbooks, model cards, scenarios
web/              Next.js 15 dashboard
infra/            docker, helm, terraform
docs/             indicators, playbook, tickers, sources
tests/            pytest + hypothesis
```

## Disclaimer (again, on purpose)

SignalClaw is a personal research tool. It is **not financial advice**. Backtest results contain biases. Model outputs can be wrong. Do not trade on this without your own due diligence and a licensed advisor.
