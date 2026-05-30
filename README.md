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

## Operations

Operational notes for running SignalClaw beyond a single laptop.

### Audit log

Every mutating API call (POST, PUT, PATCH, DELETE) and every authentication or
authorization failure on a protected route is persisted to an append-only JSONL
file under `<DATA_DIR>/audit/audit-YYYY-MM-DD.jsonl`. Files rotate daily by
filename so they can be tailed, grepped, or shipped to a SIEM with standard
tooling.

Each record contains the request id, UTC timestamp, method, path, response
status, source IP, request duration, and the API key's label plus a stable
SHA-256 prefix as `actor_key_hash`. The raw key is never written. Request
bodies and response payloads are never written.

Query recent events over HTTP (admin scope required):

```
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/audit?limit=100
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/audit/days
curl -H "x-api-key: $ADMIN_KEY" "http://localhost:8000/audit?day=2026-05-30"
```

Flip on read-side auditing during incident response by setting
`SIGNALCLAW_AUDIT_READS=1` and restarting the API. Health, docs, and metrics
endpoints are always exempt.

Clients can supply `x-request-id`; the value is echoed back on the response and
recorded in the audit row so logs across the stack can be correlated. When the
header is absent the middleware mints a 16-char id.

Retention is operator-controlled. A simple cron is sufficient:

```
find "$DATA_DIR/audit" -name 'audit-*.jsonl' -mtime +90 -delete
```

### Metrics and probes

The API exposes Prometheus metrics at `GET /metrics` in the standard
text exposition format. The endpoint is open (no API key) so that
scrapers running inside the cluster can reach it without rotating
secrets; lock it down at the ingress or NetworkPolicy layer if you
expose the API to the public internet.

Series currently exported:

- `signalclaw_http_requests_total{method,route,status}` counter
- `signalclaw_http_request_duration_seconds{method,route}` histogram
  with buckets at 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s,
  2.5s, 5s, 10s
- `signalclaw_http_in_flight_requests` gauge
- `signalclaw_build_info{version}` gauge pinned at 1

The `route` label uses the FastAPI route template (for example
`/watchlist/{ticker}`) so cardinality stays bounded under scanner or
fuzzer traffic. Unmatched paths bucket into `__unmatched__`.

Two probe endpoints back the Helm chart:

- `GET /health` is a cheap liveness probe. No I/O, no auth. If the
  process answers, Kubernetes leaves it running.
- `GET /ready` is a readiness probe. It confirms that `DATA_DIR` is
  writable by touching a `.ready_probe` file. Returns 503 when the
  data volume is missing or read-only so the service mesh removes the
  pod from rotation instead of serving 500s.

The deployment template adds standard `prometheus.io/scrape`
annotations so a default kube-prometheus install picks the API up
automatically.

### Error tracking (Sentry)

The API ships with an optional [Sentry](https://sentry.io) integration. It
stays inert until you set `SENTRY_DSN`, so local dev and CI never need a real
project or network access.

Enable it by setting these environment variables (see `.env.example`):

```
SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production         # or staging / development
SENTRY_RELEASE=0.1.0                  # usually the git SHA in CI
SENTRY_TRACES_SAMPLE_RATE=0.05        # 0.0 disables performance traces
SENTRY_PROFILES_SAMPLE_RATE=0.0       # 0.0 disables profiling
SENTRY_SEND_DEFAULT_PII=false         # leave false unless you really need it
```

What it captures:

- Unhandled exceptions from any FastAPI route, including the route
  template as the transaction name so issues group cleanly.
- `logging` records at `ERROR` or above are sent as events; `WARNING`
  and above become breadcrumbs on whatever event ships next.
- Optional performance traces and profiles, gated by the sample rate
  envs. Keep these low in production to control quota.

Before any event leaves the process the SDK runs a local scrubber that
redacts the `Authorization`, `Cookie`, and `X-Api-Key` headers and
strips any captured request body. PII is off by default. Combined with
the existing audit log (which never sees request bodies either), no
secrets or user payloads should reach the Sentry project.

Smoke test after rollout: trigger any handler that raises and confirm
the event appears in the Sentry project under the configured
`SENTRY_ENVIRONMENT`. The startup log line `sentry.enabled` confirms
the SDK initialised inside the pod.

### Deployment, scaling, backup, on-call

Deployment is described in `infra/helm/signalclaw` (chart with values) and
`infra/docker/Dockerfile.api`. Scale the API horizontally; rate limits and the
audit log are both per-process safe and append-only, so there is no shared
write contention. Back up `DATA_DIR` (parquet, JSON stores, audit/) on the
same cadence as your other stateful volumes. On-call playbook lives under
`docs/playbook.md`.

### Data lifecycle (GDPR export and delete)

SignalClaw exposes two endpoints so an operator can fulfil data subject
requests without writing ad hoc scripts. Both require the `admin` scope.

`GET /privacy/export` returns a single JSON blob containing every
user-state record on the instance: watchlist, alerts, portfolio trades,
stops, journal, brackets, earnings calendar, news events, webhooks,
drawdown history, scaling plans, FX currencies, and the full persisted
audit log grouped by UTC day. Stream it to a file:

```
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/privacy/export \
  > export-$(date -u +%Y%m%d).json
```

`POST /privacy/delete` erases user state in place. To guard against
accidents the call must include `confirm=DELETE` exactly. Audit log,
archived daily reports, and cached OHLCV are preserved by default since
they are typically retained for compliance; opt in per category with
`wipe_audit=true`, `wipe_reports=true`, and `wipe_ohlcv=true`:

```
curl -X POST -H "x-api-key: $ADMIN_KEY" \
  "http://localhost:8000/privacy/delete?confirm=DELETE"
```

Response body returns `{"ok": true, "removed": {...}, "files_removed":
[...], "errors": []}` so the action is itself auditable. The deletion
is also written to the audit log via the standard middleware.

---

Not investment advice. Paper-trading and research use only. See `FINANCIAL_DISCLAIMER.md`.
