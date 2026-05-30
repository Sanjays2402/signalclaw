# SignalClaw

Quant trading dashboard and research stack. Local-first signal generation, portfolio accounting, walk-forward optimization, and execution simulation for equities and crypto.

![landing](docs/screenshots/landing.png)

## What it does

Tracks a watchlist, ingests OHLCV via yfinance, generates daily picks from a feature pipeline (technical, sentiment, news events), and writes a dated report. Books trades into a local portfolio and produces P&L, drawdown, sector concentration, tax lots (FIFO/LIFO/HIFO with wash-sale window), and FX-converted views. Runs walk-forward parameter sweeps over rule-based strategies and child-order execution simulations under TWAP, VWAP, and POV schedules. Classifies market regime (bull / chop / bear / crash) to gate sizing. Manages alerts, bracket plans, scaling plans, stop rules, and a notifier with dead-letter queue (Telegram / Discord / Slack / webhooks).

## Features

- Watchlist + daily picks with archived report history and diffs
- Portfolio: trades, snapshot, attribution, sector concentration, drawdown tracker, tax report
- Risk: pretrade check, position sizing (equity / risk-per-trade / max-pct), correlation matrix, diversification scoring
- Walk-forward optimizer for SMA-crossover + RSI strategy (grid + train/test folds, OOS Sharpe / return / MDD)
- Execution simulator: TWAP, VWAP, POV with per-bar slippage and participation caps
- Regime detector over realized vol, trend slope, drawdown; emits a risk-scale multiplier
- Brackets (entry / stop / target with fill, close, cancel, stats)
- Stop rules engine + scaling plans (evaluate / cancel)
- Alerts with cooldown, manual or scheduled checks
- News events store + event study endpoint
- Rotation scoring, conviction journal, anomaly / data-quality reports
- FX rates + multi-currency trade view
- Notifier with DLQ, replay, and test endpoint
- Webhook subscriptions (events, ticker filter, HMAC secret)
- Next.js dashboard (pages per resource) with lightweight-charts and recharts

## Stack

- Python 3.11+, FastAPI, Pydantic v2, uvicorn, Click, structlog
- pandas, numpy, scikit-learn, lightgbm, xgboost, torch, transformers
- yfinance for OHLCV, feedparser for news
- Storage: local files under `DATA_DIR` (parquet via pyarrow, JSON)
- Web: Next.js 15, React 19, TypeScript, Tailwind v4, SWR, lightweight-charts, recharts, Phosphor icons
- Tests: pytest, hypothesis
- Optional: OpenTelemetry OTLP exporter

## Architecture

API process (FastAPI on :7431) owns all state under `DATA_DIR`. The web app (Next.js on :7430) is a read/write client talking only to the API with `SIGNALCLAW_API_KEY`. The CLI shares the same Python package, so `ingest`, `run`, `backtest`, `optimize` produce artifacts the API serves. The notifier is a synchronous module invoked by alert / bracket / stop checks and webhook fires, with a DLQ for retries.

```
yfinance / feedparser
        |
        v
   ingest  ----> data/ (parquet, json)
        |
        v
  features + models + sentiment + news_events
        |
        v
   signal-engine  ----> daily report (picks)
        |
        +--> regime detect ---> risk-scale
        |
        +--> risk.pretrade ---> execution.router (TWAP/VWAP/POV)
        |
        v
   portfolio + brackets + stops + alerts + journal
        |
        v
   notifier (telegram / discord / slack / webhooks, DLQ)

   web (Next.js :7430)  <--->  api (FastAPI :7431)  <--->  data/
```

## Quick start

```bash
git clone <repo> signalclaw && cd signalclaw

# Python env
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

# Env
cp .env.example .env
# at minimum set SIGNALCLAW_API_KEY and SIGNALCLAW_DASHBOARD_PASSWORD

# Seed data
signalclaw ingest --period 3y

# API (port 7431)
uvicorn signalclaw.api:app --host 0.0.0.0 --port 7431
# or: signalclaw serve

# Web (port 7430)
cd web && npm install && npm run dev
```

Or via docker compose:

```bash
docker compose -f docker-compose.dev.yml up --build
```

No external broker is required. The execution simulator is offline and yfinance covers data. Optional notifier credentials (Telegram / Discord / Slack / NewsAPI) can be added to `.env`.

## Configuration

| Var | Purpose |
|---|---|
| `SIGNALCLAW_API_KEY` | Bearer key required by all non-public API routes |
| `SIGNALCLAW_DASHBOARD_PASSWORD` | Web dashboard password |
| `DATA_DIR` | Path for parquet / json state (default `./data`) |
| `LOG_LEVEL` | structlog level (default `INFO`) |
| `TELEGRAM_ENABLED` | Toggle Telegram notifier |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram creds |
| `DISCORD_WEBHOOK_URL` | Discord notifier URL |
| `SLACK_WEBHOOK_URL` | Slack notifier URL |
| `NEWSAPI_KEY` | NewsAPI key for news events |
| `ENABLE_CI` | Toggle CI-only paths |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP traces endpoint |

## Scripts

CLI (`signalclaw <cmd>`, defined in `pyproject.toml` and `src/signalclaw/cli/main.py`):

| Command | Purpose |
|---|---|
| `ingest` | Pull OHLCV for the watchlist (`--period`) |
| `run` | Generate today's picks (`--today`, `--notify`, `--out`) |
| `backtest` | Backtest one ticker or the watchlist (`--ticker`, `--from`, `--period`) |
| `optimize` | Walk-forward param sweep (`--train`, `--test`, `--period`) |
| `serve` | Run the FastAPI app (`--host`, `--port`) |
| `size` | Position sizing helper (`--equity`, `--risk`, `--max-pct`) |
| `correlation` | Pairwise correlation matrix (`--window`, `--threshold`) |
| `rotation` | Rotation scoring report |
| `pretrade` | Pretrade risk check |

Makefile shortcuts: `make dev`, `make test`, `make api`, `make web`, `make ingest`, `make run`, `make backtest`.

Web (`web/`): `npm run dev`, `npm run build`, `npm run start`, `npm run lint`.

## API

All routes except `/health` and `/disclaimer` require `Authorization: Bearer $SIGNALCLAW_API_KEY`.

Public

- `GET /health`
- `GET /disclaimer`

Watchlist + picks + reports

- `GET/POST/DELETE /watchlist[/{ticker}]`
- `GET /picks`, `GET /picks/guarded`
- `GET /report.md`
- `GET /reports/history`, `GET /reports/{as_of}`
- `GET /reports/diff/latest`, `GET /reports/diff/{as_of}`
- `POST /reports/archive`

Backtest + optimization

- `GET /backtest/{ticker}`
- `GET /optimize/{ticker}` (walk-forward)

Portfolio

- `GET/POST/DELETE /portfolio/trades[/{trade_id}]`
- `GET /portfolio/snapshot`
- `GET /portfolio/attribution`
- `GET /portfolio/sectors`
- `GET /portfolio/tax`
- `GET /portfolio/drawdown`, `GET /portfolio/drawdown/history`, `POST /portfolio/drawdown/clear`
- `GET/POST/DELETE /portfolio/currency[/{trade_id}]`
- `GET /portfolio/converted`

Risk + execution

- `POST /risk/size`
- `POST /risk/pretrade`
- `POST /execution/simulate`

Correlation + diversification + rotation + regime

- `GET /correlation`
- `GET /diversification`
- `GET /rotation`
- `GET /regime`

Alerts + stops + brackets + scaling

- `GET/POST/DELETE /alerts[/{alert_id}]`, `POST /alerts/check`
- `GET/POST/DELETE /stops[/{rule_id}]`, `POST /stops/check`
- `GET/POST/DELETE /brackets[/{plan_id}]`, `GET /brackets/stats`
- `POST /brackets/{plan_id}/fill|close|cancel`
- `GET/POST/DELETE /scaling/plans[/{plan_id}]`, `POST /scaling/plans/{plan_id}/cancel|evaluate`

Journal

- `GET/POST/DELETE /journal[/{trade_id}]`
- `GET /journal/stats/conviction`

News + earnings + quality

- `GET/POST/DELETE /news-events[/{event_id}]`
- `GET /news-events/study`
- `GET/PUT/DELETE /earnings[/{ticker}]`
- `GET /quality/anomalies/{ticker}`

FX + ledger

- `GET/POST /fx`, `GET /fx/{currency}`
- `GET/POST /ledger/{account}`, `GET /ledger/{account}/snapshot`, `PUT /ledger/{account}/config`

Webhooks + notifier

- `GET/POST/DELETE /webhooks[/{sub_id}]`, `POST /webhooks/fire/latest`
- `GET/DELETE /notifier/dlq[/{item_id}]`, `POST /notifier/dlq/replay`, `POST /notifier/test`

Source of truth: `src/signalclaw/api/app.py`.

## Backtesting + Optimization

The walk-forward optimizer lives in `src/signalclaw/backtest/walk_forward_opt.py`. Strategy template is long-only SMA crossover with an RSI filter:

```
signal[t] = 1 if SMA(close, fast) > SMA(close, slow)
                 and RSI(close, rsi_period) > rsi_min
            else 0
```

Each fold grid-searches params on the train slice, picks the in-sample best-Sharpe pair, and records OOS Sharpe / return / MDD on the test slice. Run it:

```bash
signalclaw optimize SPY --train 252 --test 63 --period 5y
# or
curl -H "Authorization: Bearer $SIGNALCLAW_API_KEY" \
     "http://localhost:7431/optimize/SPY?train=252&test=63"
```

Output reports per-fold params and OOS metrics, plus aggregates (median OOS Sharpe, mean OOS return, most common params and their share). Selection never sees the test slice, so OOS Sharpe is honest.

## Execution simulator

`src/signalclaw/execution/router.py` slices a parent order into per-bar children:

- `TWAP`: equal weight across bars
- `VWAP`: proportional to a supplied session volume curve
- `POV`: participation rate of realized volume

Each slice can be capped at `max_participation` of bar volume; per-share slippage scales linearly with the slice's share of ADV. The report returns realized average price, cost vs the arrival price and the interval-VWAP benchmark, and an implementation-shortfall breakdown. Use `POST /execution/simulate` with explicit bars (the simulator never fetches market data itself).

## Project structure

```
.
├── src/signalclaw/         # Python package (api, cli, engine, backtest, execution, regime, ...)
├── packages/               # backtest, data, explain, features, models (extracted libs)
├── services/               # api, ingest, notifier, signal-engine
├── web/                    # Next.js dashboard (app router)
├── infra/docker/           # Dockerfile.api, Dockerfile.web, compose files
├── scripts/                # ops scripts
├── docs/                   # architecture, ADRs, playbook, screenshots
├── tests/                  # pytest + hypothesis
├── data/                   # local state (parquet / json)
├── pyproject.toml
├── Makefile
└── .env.example
```

## License

MIT. See `LICENSE`.

---

Not investment advice. Paper-trading and research use only. See `FINANCIAL_DISCLAIMER.md`.
