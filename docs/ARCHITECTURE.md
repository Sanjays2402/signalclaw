# Architecture

ingest -> features -> sentiment -> models -> ensemble -> ranking -> notifier
FastAPI exposes `/picks`, `/backtest/{ticker}`, `/watchlist`, `/health`, `/disclaimer`.
Web app reads from FastAPI with `x-api-key` header.

Storage: data/parquet/ohlcv_*.parquet, data/cache/sentiment/*.json, data/watchlist.json, data/artifacts/.

Observability: structlog JSON to stdout, OpenTelemetry SDK ready (set OTEL_EXPORTER_OTLP_ENDPOINT).
