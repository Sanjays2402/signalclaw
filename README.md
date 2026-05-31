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
- User-managed API keys with scopes (`read`, `trade`), one-time secret reveal, revocation, last-used timestamps; managed at `/settings/keys` in the dashboard or via `/admin/keys` over HTTP
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

## Try it: ticker page with regime overlay

Open any symbol at `http://localhost:7430/ticker/SPY` (or QQQ, AAPL, etc.) to see the live price chart with bull / chop / bear / crash markers under each bar, regime bar counts, and the current snapshot (label, risk scale, confidence). Lookback toggles between 1Y / 2Y / 5Y.

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/regime/series?ticker=SPY&lookback_days=504" | jq '.counts, .snapshot'
```

## Try it: explain a signal

See exactly why the model picked watch, hold, or skip for any ticker. The `/explain/{ticker}` endpoint runs the same per-ticker pipeline used by daily picks (technical features, ensemble classifier, return regressor) and returns the prediction with per-feature contributions, rationale text, risk flags, and a price history window.

Web: http://localhost:7430/explain — sample selector (SPY, QQQ, AAPL, NVDA, TLT, BTC-USD) or any custom ticker, 3M/6M/1Y/2Y windows, class probability bar, price spark, bullish vs bearish feature panels with weighted contribution bars, and risk flag badges.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/explain/SPY?lookback_days=120" | jq '{label, score, expected_return, proba, rationale, risk_flags}'
```

## Try it: public demo (no signup)

For a first look at SignalClaw without setup, open the public demo. It calls a rate-limited, unauthenticated endpoint locked to a small allowlist of liquid tickers (SPY, QQQ, IWM, TLT, GLD, BTC-USD), runs the real regime classifier, and shows a live price chart with bull / chop / bear / crash overlay plus a snapshot of realized vol, trend slope, and drawdown.

Web: http://localhost:7430/demo

API:

```bash
curl "http://localhost:7431/public/regime/demo?ticker=SPY&lookback_days=504" | jq '.snapshot, .counts'
```

## Try it: mint a scoped API key

User-managed keys live alongside the env-based registry. The dashboard at `/settings/keys` lists, mints, and revokes them. Secrets are SHA-256 hashed at rest and revealed exactly once at creation. Scopes `read` and `trade` can be granted from the UI; `admin` is server-config only to prevent privilege escalation.

Web: http://localhost:7430/settings/keys

API (requires an admin-scoped key, e.g. the dev fallback `dev-key`):

```bash
# create
curl -X POST http://localhost:7431/admin/keys \
  -H "x-api-key: dev-key" -H "content-type: application/json" \
  -d '{"label":"my laptop","scopes":["read","trade"]}'
# response includes "secret": "sck_..." once; copy it now

# use the new key
curl http://localhost:7431/picks -H "x-api-key: sck_..."

# revoke
curl -X DELETE http://localhost:7431/admin/keys/<id> -H "x-api-key: dev-key"
```

## Try it: regime classifier

Classify any ticker into bull, chop, bear, or crash from realized vol, 60d trend slope, and 252d drawdown. Used by the picks engine to scale position sizes (crash 0.25x, bear 0.5x, chop 0.75x, bull 1.25x).

Web: http://localhost:7430/regime — sample selector (SPY, QQQ, IWM, TLT, GLD, BTC-USD), 6M/1Y/2Y/5Y windows, price chart with per-bar regime markers, snapshot stats, and a time-in-regime breakdown.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/regime/series?ticker=SPY&lookback_days=504" | jq '.snapshot, .counts'
```

## Try it: walk-forward backtest

Run a real walk-forward backtest on any ticker. The model trains on a rolling 252-day window, steps forward 21 bars at a time, and takes long-only positions when its watch/hold/skip classifier is confident. No look-ahead. Costs and slippage applied per turnover.

Web: http://localhost:7430/backtest — sample selector (SPY, QQQ, AAPL, NVDA, TLT, BTC-USD), equity vs buy-and-hold overlay with entry/exit markers, drawdown pane, trade table, and an alpha summary.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  http://localhost:7431/backtest/SPY | jq '{cagr, benchmark_cagr, sharpe, max_drawdown, exposure, n_trades}'
```

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
header is absent the middleware mints a 16-char id. See the
[Request correlation](#request-correlation) section below for the full
propagation story.

### Audit retention

Audit JSONL files are pruned by a background daemon thread that starts with
the API process. Files whose date stamp is strictly older than the configured
threshold are deleted on a fixed sweep interval and on every process start so
a long-stopped service catches up immediately.

Configuration is environment driven and ships with safe defaults:

- `SIGNALCLAW_AUDIT_RETENTION_DAYS` (default `90`). Maximum age in UTC days.
  Set to `0` to disable retention entirely, which is only appropriate when an
  external log shipper has taken ownership of the directory.
- `SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS` (default `3600`). How often
  the sweeper wakes. The minimum effective value is 60 seconds; invalid input
  falls back to the default rather than crashing boot.

Each sweep that deletes one or more files emits a structured log line:

```
audit.retention.pruned files_removed=3 retention_days=90
```

The Helm chart exposes both knobs under `api.audit.retentionDays` and
`api.audit.retentionIntervalSeconds` in `values.yaml`, and renders them as
environment variables on the API deployment. To override the retention
window without disabling the sweeper, set the value at install time:

```
helm upgrade signalclaw infra/helm/signalclaw \
  --set api.audit.retentionDays=30
```

For compliance flows that require a permanent record, ship the audit
directory to an external write-once store (S3 with object lock, GCS bucket
lock, etc.) on a schedule shorter than the retention window. The sweeper
never touches files outside the `audit-YYYY-MM-DD.jsonl` glob, so an
adjacent staging directory is safe to colocate.

### Request correlation

Every inbound request is wrapped by `RequestContextMiddleware` (outermost
middleware on the API). It:

- Honours an inbound `X-Request-Id` header when the value matches
  `[A-Za-z0-9_-]{1,128}`, otherwise mints a fresh 16-char hex id. Malformed
  ids are dropped rather than logged, so a hostile caller cannot inject
  newlines or control characters into the log stream.
- Honours an optional `X-Correlation-Id` header for cross-system tracing
  (for example a job id from an upstream scheduler). This header is never
  minted; it is only propagated when supplied.
- Binds both ids into `structlog` contextvars so every log line emitted
  during the request, from any module, automatically carries `request_id`
  (and `correlation_id` when present) without each handler having to thread
  them manually.
- Echoes both ids back on the response and exposes them on
  `request.state.request_id` / `request.state.correlation_id` for downstream
  middleware. The audit middleware reads `request.state.request_id` so the
  audit row and the JSON logs share a single id.
- Clears the contextvars on the way out so a worker process serving the
  next request starts clean.

Grep workflow during an incident:

```
rid=$(curl -sI http://api/health | awk '/x-request-id/ {print $2}' | tr -d '\r')
jq -c "select(.request_id==\"$rid\")" /var/log/signalclaw/*.json
grep "\"request_id\":\"$rid\"" "$DATA_DIR"/audit/audit-*.jsonl
```

Retention is operator-controlled. A simple cron is sufficient:

```
find "$DATA_DIR/audit" -name 'audit-*.jsonl' -mtime +90 -delete
```

### RBAC scope enforcement

API keys carry scopes (`read`, `trade`, `admin`). A global middleware
(`ScopeEnforcementMiddleware`) maps every inbound request to the scope it
requires using the `SCOPE_RULES` table in `src/signalclaw/api/rate_limit.py`:

- `GET` against any non-exempt path needs `read`.
- `POST` / `PUT` / `PATCH` / `DELETE` against `/watchlist`, `/alerts`,
  `/portfolio/trades`, `/stops`, `/earnings`, and `/reports/archive` needs
  `trade`.
- Anything under `/admin/` needs `admin`.
- `admin` implicitly grants `read` and `trade`.

A read-only key calling a mutating route now gets a `403` with a JSON body
describing the required scope, the method, and the path, instead of being
let through because the route author forgot a per-route dependency. Health,
readiness, docs, and `/metrics` are exempt.

Configure multiple keys via `SIGNALCLAW_API_KEYS_JSON`:

```
export SIGNALCLAW_API_KEYS_JSON='[
  {"key":"ro-monitor","scopes":["read"],"label":"grafana"},
  {"key":"bot-trader","scopes":["read","trade"],"label":"discord-bot","rate_per_minute":120},
  {"key":"admin-sanjay","scopes":["read","trade","admin"],"label":"sanjay"}
]'
```

The legacy `SIGNALCLAW_API_KEY` env still works and is granted `read` +
`trade` for backwards compatibility. Rotate to the JSON form when you need
an admin key (admin endpoints are deliberately not granted to the legacy
key).

Enforcement is on by default. Set `SIGNALCLAW_RBAC_ENFORCE=0` to fall back
to the old permissive behaviour during a migration window. Coverage lives
in `tests/test_rbac_enforcement.py`.

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

### Distributed tracing (OpenTelemetry)

The API ships a real OpenTelemetry pipeline: a `TracerProvider` with a
stable `service.name` resource, OTLP/HTTP span export, and ASGI plus
httpx auto-instrumentation. It stays inert until you point
`OTEL_EXPORTER_OTLP_ENDPOINT` at a collector, so local dev and CI never
need a running OTel stack.

Enable it by setting these environment variables (see `.env.example`):

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_TRACES_SAMPLER_ARG=0.1          # 0.0 to 1.0 parent-based ratio sampler
OTEL_SERVICE_VERSION=0.1.0           # optional, falls back to package version
```

If the endpoint already includes the `/v1/traces` path it is used as-is;
otherwise the OTLP/HTTP exporter appends it. The standard upstream
`OTEL_EXPORTER_OTLP_HEADERS` is honoured by the exporter for tenant
authentication against managed backends (Honeycomb, Grafana Cloud,
Datadog OTLP intake).

What gets traced:

- Every inbound HTTP request via the FastAPI ASGI instrumentor. Span
  names use the route template (for example `GET /watchlist/{ticker}`)
  so cardinality stays bounded.
- Every outbound httpx call (yfinance fetches, notifier webhooks)
  becomes a child span under the request that triggered it.
- `/health`, `/ready`, and `/metrics` are excluded from span creation
  so probe and scrape traffic do not drown out real signal.

Log and trace correlation:

`RequestContextMiddleware` reads the active span context inside every
request and binds `trace_id` plus `span_id` into the `structlog`
contextvars alongside `request_id`. Every structured log line emitted
during the request automatically carries all three, so you can click
from a Sentry event or a log search straight to the matching trace in
your OTel backend without manually stitching ids. When tracing is
disabled the trace fields are simply absent.

Sampling guidance:

- Dev and CI: leave `OTEL_TRACES_SAMPLER_ARG=1.0` to record everything.
- Staging: `0.5` is a good starting point while you tune dashboards.
- Production: `0.05` to `0.1` keeps cost predictable; raise it during
  incident response. The sampler is parent-based, so an upstream that
  forces `sampled=1` on a trace context will always be honoured even
  when the local ratio would have dropped it.

Smoke test after rollout: hit any non-exempt endpoint and confirm a
span appears in the collector with `service.name=signalclaw-api` and
`http.route` matching the FastAPI template. Coverage lives in
`tests/test_otel_tracing.py`, which uses an in-memory exporter to
assert that the request middleware and the FastAPI instrumentor
actually emit spans and that the trace id makes it into the log
contextvars.

### Per-IP rate limiting (DoS guard)

A separate `PerIPRateLimitMiddleware` sits outside the per-API-key limiter
so a flood from a single source is shed before auth, audit, or the per-key
buckets see it. The shared `anon` bucket that the per-key limiter uses for
unauthenticated traffic would otherwise be a single chokepoint under abuse;
the per-IP layer keys off the client address so one noisy source cannot
starve every other anonymous caller.

Tunables (all env, no restart-time discovery):

| Var | Default | Effect |
| --- | --- | --- |
| `SIGNALCLAW_PER_IP_PER_MIN` | `600` | Token-bucket capacity and refill in requests per minute per source IP. Set to `0` to disable the layer entirely (not recommended for any public exposure). |
| `SIGNALCLAW_TRUST_FORWARDED` | `0` | When `1`, parse the leftmost entry of `X-Forwarded-For` (or `X-Real-IP` as a fallback) so the bucket keys off the real client behind a reverse proxy. Off by default so a direct attacker cannot spoof the header. |
| `SIGNALCLAW_TRUSTED_PROXIES` | empty | Comma-separated allowlist of peer IPs whose forwarded headers will be honoured. When `SIGNALCLAW_TRUST_FORWARDED=1` and this list is empty, any peer is trusted (use only when the API is never reachable except through a known L7 proxy). |

Exceeded buckets return HTTP 429 with `Retry-After`, an `X-RateLimit-Scope:
per-ip` header, and a JSON body `{"detail":"per-ip rate limit exceeded",
"scope":"per-ip","retry_after_seconds":N}`. Health, readiness, docs, and
`/metrics` are exempt so probes and scrapers are never throttled.

Deployment notes:

- Behind nginx or an ingress controller, set `SIGNALCLAW_TRUST_FORWARDED=1`
  and pin `SIGNALCLAW_TRUSTED_PROXIES` to the proxy pod IPs. Without that,
  every request looks like it came from the proxy and the whole cluster
  shares one bucket.
- The per-IP layer composes with the existing per-key limiter
  (`SIGNALCLAW_RATE_LIMIT_ENABLED=1`): per-IP fires first, per-key fires
  after, and a request must clear both. Tune `SIGNALCLAW_PER_IP_PER_MIN`
  higher than the sum of per-key budgets you expect from a single source.
- Buckets live in-process. With multiple API replicas, each pod enforces
  its own bucket, so the effective ceiling is `replicas * per_minute`.
  That is fine as a DoS guard; for strict global quotas use the per-key
  budgets backed by your gateway.

Coverage lives in `tests/test_per_ip_rate_limit.py`.

### Deployment, scaling, backup, on-call

Deployment is described in `infra/helm/signalclaw` (chart with values) and
`infra/docker/Dockerfile.api`. Scale the API horizontally; rate limits and the
audit log are both per-process safe and append-only, so there is no shared
write contention. Back up `DATA_DIR` (parquet, JSON stores, audit/) on the
same cadence as your other stateful volumes. On-call playbook lives under
`docs/playbook.md`.

The Helm chart ships hardened defaults: non-root pod security context
(`runAsNonRoot`, `seccompProfile: RuntimeDefault`), per-container CPU and
memory requests/limits, dropped Linux capabilities, read-only root filesystem
with `emptyDir` mounts for `/tmp` and `DATA_DIR`, a dedicated
`ServiceAccount` with `automountServiceAccountToken: false`, and Prometheus
scrape annotations on the API pod. Production-only toggles (all opt-in):

| Key | Effect |
| --- | --- |
| `api.autoscaling.enabled=true` | Renders an HPA on CPU and memory utilisation. `web.autoscaling.enabled=true` does the same for the web pod. |
| `api.podDisruptionBudget.enabled=true` | Renders a PDB with `minAvailable: 1` so the API survives node drains. |
| `networkPolicy.enabled=true` | Locks API ingress to the web pod only, restricts egress to DNS plus the configured `egressCIDRs` on 80/443. |
| `api.persistence.enabled=true` | Creates a PVC bound at `DATA_DIR` (default `/data`) so audit log, journal, and parquet stores survive pod restarts. |
| `api.sentry.dsnSecret=<secret>` | Threads `SENTRY_DSN` from the named secret (`key: dsn`) plus environment, release, and sample rates into the API container. |
| `ingress.enabled=true` | Renders an Ingress with `ingressClassName`, `annotations`, and `tls` passthrough from values. |

The chart is covered by `tests/test_helm_chart.py`, which shells out to
`helm template` and asserts every container has resource limits, the pod
security context is non-root, capabilities are dropped, read-only root
filesystem has writable volume mounts, probes are wired to `/health` and
`/ready`, and each opt-in toggle produces the expected manifest. Run
`pytest tests/test_helm_chart.py` after any chart change.

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

### Container image

The API ships as a hardened multi-stage image defined in
`infra/docker/Dockerfile.api`. The builder stage compiles dependencies and
builds a non-editable wheel into an isolated virtualenv; the runtime stage
copies only that venv onto a slim `python:3.11-slim` base, drops to a
dedicated non-root system account (`signalclaw`, uid/gid 10001), and uses
`tini` as PID 1 so `SIGTERM` from Kubernetes or `docker stop` reaches
uvicorn cleanly. A `HEALTHCHECK` probes `/health` every 30 seconds so
`docker ps` and compose-level restarts see real liveness signal even when
run outside Kubernetes.

Build and run locally:

```
docker build -f infra/docker/Dockerfile.api -t signalclaw-api:local .
docker run --rm -p 7431:7431 --env-file .env signalclaw-api:local
```

The data directory inside the container is `/var/lib/signalclaw`, owned by
the `signalclaw` user. Mount a persistent volume there in production so
the audit log, cached OHLCV, and archived reports survive pod restarts.
The shape of the image (multi-stage, non-root, wheel install, healthcheck,
tini entrypoint) is enforced by `tests/test_docker_api_image.py` so a
regression in any of those properties breaks CI before it ships.

### Lint and dependency audit

The `ci` workflow gates merges on three Python jobs in addition to the
web build:

- `lint` runs `ruff check .` against the entire repo using the config
  in `pyproject.toml` (`[tool.ruff]`). The selected rule set is
  pyflakes plus a focused slice of pycodestyle (`F`, `E4`, `E7`, `E9`,
  `W6`) with per-file ignores for `__init__.py` re-exports and tests.
  Local contributors get the same gate from `pytest`: `tests/test_lint_ruff.py`
  shells out to `ruff check .` and fails the suite when it finds new
  violations. The test is skipped, not failed, when `ruff` is missing
  so a minimal runtime install still passes.
- `test` depends on `lint` and runs the full `pytest -q` suite, so a
  lint regression short-circuits the slower test job and saves runner
  minutes.
- `security-audit` runs `pip-audit --strict` against the installed
  dependency tree. It is marked `continue-on-error: true` so newly
  disclosed advisories surface as a CI warning instead of an outage,
  with the expectation that on-call triages the advisory the same day
  and either pins around it or adds it to the ignore list with a
  link to the upstream fix PR.

A fourth job, `helm`, installs the `helm` CLI on the runner and renders
the chart end to end so the hardening invariants documented above are
actually gated. It runs:

- `helm lint infra/helm/signalclaw` to catch schema regressions.
- `helm template t infra/helm/signalclaw` to confirm the default values
  render without error.
- `pytest tests/test_helm_chart.py tests/test_helm_chart_ci.py` to
  assert resource limits, non-root security context, dropped
  capabilities, read-only root filesystem, probes, and the
  HPA/PDB/NetworkPolicy/PVC/Sentry toggles all produce the expected
  manifests. `test_helm_chart.py` self-skips when `helm` is missing, so
  the dedicated CI job exists to guarantee it never silently skips on
  the GitHub runner. `test_helm_chart_ci.py` parses `ci.yml` itself and
  fails if the helm job ever loses its `azure/setup-helm` install,
  `helm lint`, `helm template`, or PyYAML setup steps, which closes the
  "chart hardening tests skipped because the runner had no helm" loop
  for good.

Run the same gate locally before pushing:

```
ruff check .
pip-audit
helm lint infra/helm/signalclaw
pytest -q
```

### Production secret validation

`Settings` runs a pydantic `model_validator` at boot that refuses to start the
API when known-weak sample secrets survive into a production or staging
rollout. The check is intentionally loud: if it triggers, the process exits
with a `pydantic.ValidationError` listing every offending variable so the
operator can see the full picture in one log line rather than chasing one
failure at a time.

Set the deployment environment with `SIGNALCLAW_ENV`. Accepted values are
`development`, `test`, `staging`, and `production`. Anything else is
rejected at parse time. Local boots default to `development` and skip the
strict checks so workflows like `make api` and the test suite keep working
without extra env wiring.

When `SIGNALCLAW_ENV` is `staging` or `production`, all of the following
must hold or the process refuses to boot:

- `SIGNALCLAW_API_KEY` is not one of the sample values shipped in
  `.env.example` (`change-me-local-dev-only`, `change-me`, `dev-key`, etc.)
  and is at least 16 characters long.
- `SIGNALCLAW_DASHBOARD_PASSWORD` is not a sample value and is at least 16
  characters long.
- `SENTRY_ENVIRONMENT` is not still `development` when `SENTRY_DSN` is set,
  so errors are not mistagged.
- `TELEGRAM_ENABLED=true` is accompanied by a non-empty `TELEGRAM_BOT_TOKEN`,
  so delivery does not silently no-op.

Generate a fresh API key with `openssl rand -hex 24` and store it in your
secret manager of choice. Rotating a key is a single environment-variable
change plus a pod restart; the legacy single-key path stays compatible with
the RBAC registry described above.

---

Not investment advice. Paper-trading and research use only. See `FINANCIAL_DISCLAIMER.md`.
