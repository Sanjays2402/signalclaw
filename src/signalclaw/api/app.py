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
from .schemas import (DailyReportOut, Pick, WatchlistOut, WatchlistIn, BacktestOut,
                       AlertIn, AlertOut, AlertListOut, AlertHitOut, AlertCheckOut,
                       TradeIn, TradeOut, TradeListOut, PortfolioSnapshotOut,
                       SizingOut, SizingRequest,
                       CorrelationMatrixOut, DiversificationOut,
                       ReportSummaryOut, ReportHistoryOut, ReportDiffOut,
                       StopRuleIn, StopRuleOut, StopRuleListOut,
                       StopEventOut, StopCheckOut,
                       AttributionOut, TickerContributionOut,
                       EarningsIn, EarningsOut, EarningsListOut,
                       ConcentrationOut, SectorExposureOut)
from .security import require_api_key
from .middleware import AccessLogMiddleware
from ..alerts import Alert, AlertCondition, AlertStore, evaluate_alerts
from ..portfolio import (PortfolioStore, Trade, TradeSide, compute_snapshot,
                          StopRule, StopKind, StopStore, evaluate_rules,
                          attribution, sector_exposure)
from ..risk import RiskConfig, size_pick
from ..correlation import correlation_matrix, diversification_warnings
from ..history import ReportArchive, diff_reports
from ..regime import detect_regime
from ..earnings import EarningsStore, EarningsDate


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
    portfolio_store = PortfolioStore(settings.data_dir / "portfolio.json")
    stops_store = StopStore(settings.data_dir / "stops.json")
    earnings_store = EarningsStore(settings.data_dir / "earnings.json")
    archive = ReportArchive(settings.data_dir / "reports")

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

    @app.get("/portfolio/trades", response_model=TradeListOut, dependencies=[Depends(require_api_key)])
    def portfolio_trades_list():
        return TradeListOut(trades=[TradeOut(**t.to_dict()) for t in portfolio_store.trades()])

    @app.post("/portfolio/trades", response_model=TradeOut, dependencies=[Depends(require_api_key)])
    def portfolio_trade_add(body: TradeIn):
        try:
            side = TradeSide(body.side.lower())
        except ValueError:
            raise HTTPException(400, f"unknown side {body.side}")
        tr = Trade(ticker=body.ticker.upper(), side=side, quantity=body.quantity,
                   price=body.price, date=body.date, fees=body.fees, note=body.note)
        portfolio_store.add_trade(tr)
        return TradeOut(**tr.to_dict())

    @app.delete("/portfolio/trades/{trade_id}", dependencies=[Depends(require_api_key)])
    def portfolio_trade_remove(trade_id: str):
        ok = portfolio_store.remove_trade(trade_id)
        if not ok:
            raise HTTPException(404, "trade not found")
        return {"removed": trade_id}

    @app.get("/portfolio/snapshot", response_model=PortfolioSnapshotOut, dependencies=[Depends(require_api_key)])
    def portfolio_snapshot():
        positions = portfolio_store.positions()
        last_prices: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        return PortfolioSnapshotOut(**snap.to_dict())

    @app.post("/risk/size", response_model=SizingOut, dependencies=[Depends(require_api_key)])
    def risk_size(body: SizingRequest):
        df = load_ohlcv(body.ticker.upper())
        if df.empty:
            df = fetch_ohlcv(body.ticker.upper(), period="1y")
            if not df.empty:
                save_ohlcv(body.ticker.upper(), df)
        if df.empty:
            raise HTTPException(404, "no data for ticker")
        cfg = RiskConfig(
            equity=body.equity,
            risk_per_trade=body.risk_per_trade,
            max_position_pct=body.max_position_pct,
            kelly_fraction=body.kelly_fraction,
            kelly_cap=body.kelly_cap,
            atr_stop_mult=body.atr_stop_mult,
            atr_target_mult=body.atr_target_mult,
        )
        res = size_pick(body.ticker.upper(), df, body.label, body.score, cfg)
        return SizingOut(**res.to_dict())

    def _gather_closes(tickers):
        out = {}
        for t in tickers:
            t = t.upper()
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="1y")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                out[t] = df["close"]
        return out

    @app.get("/correlation", response_model=CorrelationMatrixOut, dependencies=[Depends(require_api_key)])
    def correlation_endpoint(window: int = 60, tickers: str | None = None):
        if tickers:
            tlist = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        else:
            tlist = store.list()
        closes = _gather_closes(tlist)
        m = correlation_matrix(closes, window=window)
        if m.empty:
            return CorrelationMatrixOut(tickers=list(closes.keys()), matrix=[], window=window)
        return CorrelationMatrixOut(
            tickers=list(m.index),
            matrix=[[float(x) for x in row] for row in m.values],
            window=window,
        )

    @app.get("/diversification", response_model=DiversificationOut, dependencies=[Depends(require_api_key)])
    def diversification_endpoint(window: int = 60, threshold: float = 0.70):
        tlist = store.list()
        closes = _gather_closes(tlist)
        # Use portfolio weights if a snapshot is available
        weights = None
        try:
            positions = portfolio_store.positions()
            last_prices = {}
            for t in positions:
                df = load_ohlcv(t)
                if not df.empty and "close" in df.columns:
                    last_prices[t] = float(df["close"].iloc[-1])
            snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
            if snap.weights:
                weights = snap.weights
        except Exception:
            weights = None
        rep = diversification_warnings(closes, weights=weights, window=window,
                                       cluster_threshold=threshold)
        d = rep.to_dict()
        return DiversificationOut(**d)

    @app.get("/portfolio/attribution", response_model=AttributionOut, dependencies=[Depends(require_api_key)])
    def portfolio_attribution(window: int = 60, benchmark: str = "SPY"):
        positions = portfolio_store.positions()
        if not positions:
            raise HTTPException(404, "no positions")
        last_prices: dict = {}
        closes: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
                closes[t] = df["close"]
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        if not snap.weights:
            raise HTTPException(422, "weights unavailable (need last prices)")
        bdf = load_ohlcv(benchmark)
        if bdf.empty:
            bdf = fetch_ohlcv(benchmark, period="2y")
            if not bdf.empty:
                save_ohlcv(benchmark, bdf)
        if bdf.empty or "close" not in bdf.columns:
            raise HTTPException(404, f"no benchmark data for {benchmark}")
        rep = attribution(snap.weights, closes, bdf["close"], window=window)
        if rep is None:
            raise HTTPException(422, "insufficient overlapping history")
        d = rep.to_dict()
        d["benchmark"] = benchmark.upper()
        return AttributionOut(**d)

    @app.get("/portfolio/sectors", response_model=ConcentrationOut, dependencies=[Depends(require_api_key)])
    def portfolio_sectors(sector_cap: float = 0.35, position_cap: float = 0.25):
        positions = portfolio_store.positions()
        if not positions:
            raise HTTPException(404, "no positions")
        last_prices: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        if not snap.weights:
            raise HTTPException(422, "weights unavailable (need last prices)")
        mv = {p.ticker: p.market_value for p in snap.positions}
        rep = sector_exposure(
            snap.weights, market_values=mv,
            sector_cap=sector_cap, position_cap=position_cap,
        )
        return ConcentrationOut(**rep.to_dict())

    @app.get("/regime", dependencies=[Depends(require_api_key)])
    def regime_endpoint(ticker: str = "SPY"):
        df = load_ohlcv(ticker)
        if df.empty:
            df = fetch_ohlcv(ticker, period="3y")
            if not df.empty:
                save_ohlcv(ticker, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        snap = detect_regime(df["close"])
        if snap is None:
            raise HTTPException(422, "insufficient history")
        return snap.to_dict()

    @app.get("/earnings", response_model=EarningsListOut, dependencies=[Depends(require_api_key)])
    def earnings_list(within_days: int | None = None):
        if within_days is not None:
            rows = earnings_store.upcoming(within_days=int(within_days))
        else:
            rows = earnings_store.list()
        return EarningsListOut(rows=[EarningsOut(**e.to_dict()) for e in rows])

    @app.put("/earnings/{ticker}", response_model=EarningsOut, dependencies=[Depends(require_api_key)])
    def earnings_upsert(ticker: str, body: EarningsIn):
        try:
            from datetime import datetime as _dt
            _dt.fromisoformat(body.next_report)
        except Exception:
            raise HTTPException(400, "next_report must be ISO date YYYY-MM-DD")
        e = EarningsDate(ticker=ticker.upper(), next_report=body.next_report,
                         confirmed=body.confirmed, source=body.source)
        earnings_store.set(e)
        return EarningsOut(**e.to_dict())

    @app.delete("/earnings/{ticker}", dependencies=[Depends(require_api_key)])
    def earnings_remove(ticker: str):
        if not earnings_store.remove(ticker):
            raise HTTPException(404, "not found")
        return {"ok": True}

    @app.get("/stops", response_model=StopRuleListOut, dependencies=[Depends(require_api_key)])
    def stops_list():
        return StopRuleListOut(rules=[StopRuleOut(**r.to_dict()) for r in stops_store.list()])

    @app.post("/stops", response_model=StopRuleOut, dependencies=[Depends(require_api_key)])
    def stops_add(body: StopRuleIn):
        try:
            kind = StopKind(body.kind)
        except ValueError:
            raise HTTPException(400, f"invalid kind: {body.kind}")
        if kind == StopKind.TRAILING and not (0 < body.value < 1):
            raise HTTPException(400, "trailing value must be a fraction in (0, 1)")
        if kind in (StopKind.STOP_LOSS, StopKind.TAKE_PROFIT) and body.value <= 0:
            raise HTTPException(400, "price level must be positive")
        rule = StopRule(ticker=body.ticker.upper(), kind=kind,
                        value=float(body.value), note=body.note)
        stops_store.add(rule)
        return StopRuleOut(**rule.to_dict())

    @app.delete("/stops/{rule_id}", dependencies=[Depends(require_api_key)])
    def stops_remove(rule_id: str):
        ok = stops_store.remove(rule_id)
        if not ok:
            raise HTTPException(404, "rule not found")
        return {"ok": True}

    @app.post("/stops/check", response_model=StopCheckOut, dependencies=[Depends(require_api_key)])
    def stops_check():
        rules = stops_store.list()
        prices: dict = {}
        for r in rules:
            df = load_ohlcv(r.ticker)
            if not df.empty and "close" in df.columns:
                prices[r.ticker] = float(df["close"].iloc[-1])
        events = evaluate_rules(rules, prices)
        for r in rules:
            if r.kind == StopKind.TRAILING:
                stops_store.update(r)
        return StopCheckOut(
            checked=len(rules),
            events=[StopEventOut(**e.to_dict()) for e in events],
        )

    @app.get("/reports/history", response_model=ReportHistoryOut, dependencies=[Depends(require_api_key)])
    def reports_history(limit: int = 30):
        rows = archive.summaries(limit=limit)
        return ReportHistoryOut(summaries=[ReportSummaryOut(**r.to_dict()) for r in rows])

    @app.get("/reports/diff/latest", response_model=ReportDiffOut, dependencies=[Depends(require_api_key)])
    def reports_diff_latest():
        d = archive.diff_latest()
        if d is None:
            raise HTTPException(404, "no reports archived")
        return ReportDiffOut(**d.to_dict())

    @app.get("/reports/diff/{as_of}", response_model=ReportDiffOut, dependencies=[Depends(require_api_key)])
    def reports_diff_for(as_of: str, vs: str | None = None):
        d = archive.diff_between(as_of, vs)
        if d is None:
            raise HTTPException(404, "report not found")
        return ReportDiffOut(**d.to_dict())

    @app.post("/reports/archive", response_model=ReportSummaryOut, dependencies=[Depends(require_api_key)])
    def reports_archive_now():
        rep = run_daily(store.list(), refresh=False)
        archive.save(rep)
        from ..history.archive import _summary
        return ReportSummaryOut(**_summary(rep).to_dict())

    @app.get("/reports/{as_of}", response_model=DailyReportOut, dependencies=[Depends(require_api_key)])
    def reports_get(as_of: str):
        r = archive.load(as_of)
        if r is None:
            raise HTTPException(404, "report not found")
        return DailyReportOut(as_of=r.as_of,
                              picks=[Pick(**p.to_dict()) for p in r.picks])

    return app


app = create_app()
