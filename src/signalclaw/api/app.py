from __future__ import annotations
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from ..config import get_settings
from ..logging_ import configure_logging, get_logger
from ..utils import init_tracing
from ..data import WatchlistStore, load_ohlcv, fetch_ohlcv, save_ohlcv
from ..engine import run_daily, render_markdown
from ..backtest import WalkForwardBacktest
from .schemas import DailyReportOut, Pick, WatchlistOut, WatchlistIn, BacktestOut, AlertIn, AlertOut, AlertListOut, AlertHitOut, AlertCheckOut
from .security import require_api_key
from .middleware import AccessLogMiddleware
from ..alerts import Alert, AlertCondition, AlertStore, evaluate_alerts


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    init_tracing("signalclaw-api", settings.otel_endpoint)
    log = get_logger("api")
    app = FastAPI(title="SignalClaw API", version="0.1.0",
                  description="NOT FINANCIAL ADVICE.")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(AccessLogMiddleware)
    wl_path = settings.data_dir / "watchlist.json"
    store = WatchlistStore(wl_path)
    alert_store = AlertStore(settings.data_dir / "alerts.json")

    @app.get("/health")
    def health():
        return {"status": "ok", "ts": datetime.utcnow().isoformat()}

    @app.get("/disclaimer")
    def disclaimer():
        return {"text": "SignalClaw is NOT financial advice. See FINANCIAL_DISCLAIMER.md."}

    @app.get("/watchlist", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def get_watchlist():
        return WatchlistOut(tickers=store.list())

    @app.post("/watchlist", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def add_watchlist(body: WatchlistIn):
        return WatchlistOut(tickers=store.add(body.ticker))

    @app.delete("/watchlist/{ticker}", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def remove_watchlist(ticker: str):
        return WatchlistOut(tickers=store.remove(ticker))

    @app.get("/picks", response_model=DailyReportOut, dependencies=[Depends(require_api_key)])
    def picks(refresh: bool = False):
        rep = run_daily(store.list(), refresh=refresh)
        return DailyReportOut(as_of=rep.as_of, picks=[Pick(**p.to_dict()) for p in rep.picks])

    @app.get("/report.md", dependencies=[Depends(require_api_key)])
    def picks_markdown(refresh: bool = False):
        rep = run_daily(store.list(), refresh=refresh)
        return {"markdown": render_markdown(rep)}

    @app.get("/backtest/{ticker}", response_model=BacktestOut, dependencies=[Depends(require_api_key)])
    def backtest(ticker: str, refresh: bool = False):
        df = load_ohlcv(ticker)
        if df.empty or refresh:
            df = fetch_ohlcv(ticker, period="3y")
            if not df.empty:
                save_ohlcv(ticker, df)
        if df.empty:
            raise HTTPException(404, "no data")
        bt = WalkForwardBacktest().run(df)
        return BacktestOut(
            ticker=ticker, sharpe=bt.sharpe, sortino=bt.sortino,
            max_drawdown=bt.max_drawdown, hit_rate=bt.hit_rate, cagr=bt.cagr,
            n_trades=bt.n_trades,
            equity_curve=[float(x) for x in bt.equity.tolist()],
            dates=[d.strftime("%Y-%m-%d") for d in bt.equity.index],
        )

    @app.get("/alerts", response_model=AlertListOut, dependencies=[Depends(require_api_key)])
    def alerts_list(ticker: str | None = None):
        rows = alert_store.list(ticker=ticker)
        return AlertListOut(alerts=[AlertOut(**a.to_dict()) for a in rows])

    @app.post("/alerts", response_model=AlertOut, dependencies=[Depends(require_api_key)])
    def alerts_add(body: AlertIn):
        try:
            cond = AlertCondition(body.condition)
        except ValueError:
            raise HTTPException(400, f"unknown condition {body.condition}")
        a = Alert(ticker=body.ticker.upper(), condition=cond, value=body.value,
                  note=body.note, cooldown_hours=body.cooldown_hours,
                  enabled=body.enabled)
        alert_store.add(a)
        return AlertOut(**a.to_dict())

    @app.delete("/alerts/{alert_id}", dependencies=[Depends(require_api_key)])
    def alerts_remove(alert_id: str):
        ok = alert_store.remove(alert_id)
        if not ok:
            raise HTTPException(404, "alert not found")
        return {"removed": alert_id}

    @app.post("/alerts/check", response_model=AlertCheckOut, dependencies=[Depends(require_api_key)])
    def alerts_check():
        rows = alert_store.list()
        ohlcv: dict = {}
        for t in {a.ticker for a in rows}:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            ohlcv[t] = df
        hits = evaluate_alerts(rows, ohlcv)
        for a in rows:
            alert_store.update(a)
        return AlertCheckOut(
            checked=len(rows),
            hits=[AlertHitOut(**h.to_dict()) for h in hits],
        )

    return app


app = create_app()
