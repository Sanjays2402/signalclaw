.PHONY: dev test web api ingest run backtest fmt
dev:
	python3 -m venv .venv && . .venv/bin/activate && pip install -e .
test:
	pytest -q
web:
	cd web && npm install && npm run dev
api:
	uvicorn signalclaw.api:app --host 0.0.0.0 --port 7431
ingest:
	signalclaw ingest --period 3y
run:
	signalclaw run --today
backtest:
	signalclaw backtest --ticker SPY --from 2024-01-01
