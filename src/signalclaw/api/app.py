from __future__ import annotations
import os
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from ..config import get_settings
from ..logging_ import configure_logging, get_logger
from ..utils import init_tracing
from ..data import WatchlistStore, load_ohlcv, fetch_ohlcv, save_ohlcv
from ..engine import run_daily, render_markdown
from ..backtest import WalkForwardBacktest, walk_forward_optimize
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
                       ConcentrationOut, SectorExposureOut,
                       TaxReportOut,
                       OptFoldOut, OptResultOut,
                       WebhookIn, WebhookOut, WebhookListOut,
                       PickEventOut, WebhookDeliveryOut,
                       DrawdownReportOut, DrawdownConfigIn,
                       DrawdownStateOut, DrawdownConfigOut,
                       JournalEntryIn, JournalEntryOut, JournalListOut,
                       ConvictionBucketOut, ConvictionStatsOut,
                       FxRateIn, FxRateOut, FxListOut,
                       TradeCurrencyIn, TradeCurrencyOut,
                       ConversionAuditOut, ConvertedTradesOut,
                       DeadLetterOut, DeadLetterListOut, DlqReplayOut,
                       NotifyTestIn,
                       BracketPlanIn, BracketFillIn, BracketCloseIn,
                       BracketPlanOut, BracketListOut, BracketStatsOut,
                       SectorScoreOut, RotationOut,
                       NewsEventIn, NewsEventOut, NewsEventListOut, EventStudyOut,
                       CostModelIn, PretradeIn, PretradeOut,
                       ExecSimulateIn, ExecReportOut, ExecFillOut,
                       LedgerEntryIn, LedgerEntryOut, LedgerListOut,
                       MarginConfigIn, MarginConfigOut, AccountSnapshotOut,
                       AnomalyOut, AnomalyReportOut,
                       ScalingPlanIn, ScalingPlanOut, ScalingPlanListOut,
                       ScaleRungIn, ScaleBarIn, ScaleEvaluateIn,
                       ScaleEventOut, ScaleEvaluateOut)
from .security import require_api_key
from .middleware import AccessLogMiddleware
from .rate_limit import RateLimitMiddleware, require_scope
from ..audit import AuditMiddleware, get_audit_log
from ..alerts import Alert, AlertCondition, AlertStore, evaluate_alerts
from ..portfolio import (PortfolioStore, Trade, TradeSide, compute_snapshot,
                          StopRule, StopKind, StopStore, evaluate_rules,
                          attribution, sector_exposure, tax_summary, LotMethod,
                          DrawdownConfig, DrawdownGuardStore, evaluate_guard,
                          filter_picks as drawdown_filter_picks,
                          JournalEntry, JournalStore, conviction_stats,
                          FxStore, TradeCurrencyMap, convert_trades, USD,
                          BracketPlan, BracketStore, compute_bracket_stats,
                          LedgerStore, LedgerEntry, EntryKind, MarginConfig,
                          ledger_snapshot,
                          ScalingPlan, ScaleRung, ScaleAction, PlanStatus,
                          PriceBar, ScalingPlanStore, evaluate_plan)
from ..notifier import (TelegramNotifier, DiscordNotifier, SlackNotifier,
                         DeadLetterQueue, RetryPolicy, send_with_retry,
                         replay_dlq, Notifier)
from ..risk import RiskConfig, size_pick
from ..risk.pretrade import CostModel, OrderRequest, simulate_order
from ..execution import (IntradayBar, ParentOrder, ScheduleKind,
                          simulate_execution as exec_simulate)
from ..correlation import correlation_matrix, diversification_warnings
from ..rotation import sector_rotation
from ..news_events import NewsEvent, NewsEventStore, event_study
from ..history import ReportArchive, diff_reports
from ..webhooks import (WebhookStore, WebhookSubscription, diff_picks,
                         deliver_events, EVENT_KINDS)
from ..regime import detect_regime
from ..earnings import EarningsStore, EarningsDate
from ..quality import detect_anomalies, DetectorConfig


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    init_tracing("signalclaw-api", settings.otel_endpoint)
    log = get_logger("api")
    app = FastAPI(title="SignalClaw API", version="0.1.0",
                  description="NOT FINANCIAL ADVICE.")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.add_middleware(AccessLogMiddleware)
    # Audit log: persist who/what/when for mutating + auth-failed requests.
    # Sits inside CORS so it sees the real request status, including 401/403.
    audit_log = get_audit_log(settings.data_dir / "audit")
    app.add_middleware(
        AuditMiddleware,
        audit_log=audit_log,
        audit_reads=os.environ.get("SIGNALCLAW_AUDIT_READS", "0") == "1",
    )
    if os.environ.get("SIGNALCLAW_RATE_LIMIT_ENABLED", "0") == "1":
        app.add_middleware(
            RateLimitMiddleware,
            default_per_minute=int(os.environ.get("SIGNALCLAW_RATE_LIMIT_READ_PER_MIN", "120")),
            write_per_minute=int(os.environ.get("SIGNALCLAW_RATE_LIMIT_WRITE_PER_MIN", "30")),
        )
    wl_path = settings.data_dir / "watchlist.json"
    store = WatchlistStore(wl_path)
    alert_store = AlertStore(settings.data_dir / "alerts.json")
    portfolio_store = PortfolioStore(settings.data_dir / "portfolio.json")
    stops_store = StopStore(settings.data_dir / "stops.json")
    earnings_store = EarningsStore(settings.data_dir / "earnings.json")
    archive = ReportArchive(settings.data_dir / "reports")
    webhooks_store = WebhookStore(settings.data_dir / "webhooks.json")
    drawdown_store = DrawdownGuardStore(settings.data_dir / "drawdown_guard.json")
    journal_store = JournalStore(settings.data_dir / "journal.json")
    fx_store = FxStore(settings.data_dir / "fx")
    bracket_store = BracketStore(settings.data_dir / "brackets.json")
    news_event_store = NewsEventStore(settings.data_dir / "news_events.json")
    ccy_map = TradeCurrencyMap(settings.data_dir / "trade_currency.json")
    dlq = DeadLetterQueue(settings.data_dir / "notifier_dlq.json")
    ledger_store = LedgerStore(settings.data_dir / "ledger.json")
    scaling_store = ScalingPlanStore(settings.data_dir / "scaling.json")

    def _notifier_for(channel: str) -> Notifier | None:
        c = (channel or "").lower()
        if c == "slack":
            return SlackNotifier()
        if c == "telegram":
            return TelegramNotifier()
        if c == "discord":
            return DiscordNotifier()
        return None

    @app.get("/health")
    def health():
        return {"status": "ok", "ts": datetime.utcnow().isoformat()}

    @app.get("/audit", dependencies=[Depends(require_scope("admin"))])
    def audit_tail(limit: int = 100, day: str | None = None):
        """Return recent audit events. Admin scope required.

        ``day`` is a UTC ``YYYY-MM-DD`` string; defaults to today. The
        log itself is append-only on disk under ``<data_dir>/audit/``.
        """
        limit = max(1, min(int(limit), 1000))
        return {
            "day": day or datetime.utcnow().strftime("%Y-%m-%d"),
            "events": audit_log.tail(limit=limit, day=day),
        }

    @app.get("/audit/days", dependencies=[Depends(require_scope("admin"))])
    def audit_days():
        return {"days": audit_log.list_days()}

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

    @app.get("/news-events", response_model=NewsEventListOut,
             dependencies=[Depends(require_api_key)])
    def news_events_list_ep(ticker: str | None = None, tag: str | None = None,
                             date_from: str | None = None, date_to: str | None = None):
        rows = news_event_store.list(ticker=ticker, tag=tag,
                                        date_from=date_from, date_to=date_to)
        return NewsEventListOut(events=[NewsEventOut(**e.to_dict()) for e in rows])

    @app.post("/news-events", response_model=NewsEventOut,
              dependencies=[Depends(require_api_key)])
    def news_events_create_ep(body: NewsEventIn):
        try:
            ev = NewsEvent(
                ticker=body.ticker, headline=body.headline,
                event_date=body.event_date, tags=list(body.tags),
                source=body.source, url=body.url,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        news_event_store.add(ev)
        return NewsEventOut(**ev.to_dict())

    @app.delete("/news-events/{event_id}",
                dependencies=[Depends(require_api_key)])
    def news_events_remove_ep(event_id: str):
        if not news_event_store.remove(event_id):
            raise HTTPException(404, "event not found")
        return {"removed": event_id}

    @app.get("/news-events/study", response_model=EventStudyOut,
             dependencies=[Depends(require_api_key)])
    def news_events_study_ep(tag: str | None = None,
                              horizons: str = "1,5,20"):
        try:
            hz = tuple(int(x) for x in horizons.split(",") if x.strip())
        except ValueError:
            raise HTTPException(400, "horizons must be comma-separated integers")
        if not hz:
            raise HTTPException(400, "horizons required")
        events = news_event_store.list(tag=tag)
        tickers = sorted({e.ticker for e in events})
        closes = _gather_closes(tickers) if tickers else {}
        try:
            rep = event_study(events, closes, horizons=hz)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return EventStudyOut(**rep.to_dict())

    @app.post("/risk/pretrade", response_model=PretradeOut,
              dependencies=[Depends(require_api_key)])
    def pretrade_endpoint(body: PretradeIn):
        cm = body.cost or CostModelIn()
        try:
            req = OrderRequest(
                ticker=body.ticker, side=body.side,
                price=body.price, stop=body.stop, target=body.target,
                equity=body.equity,
                risk_per_trade=body.risk_per_trade,
                max_position_pct=body.max_position_pct,
                max_portfolio_pct=body.max_portfolio_pct,
                min_shares=body.min_shares,
                existing_shares=body.existing_shares,
                existing_avg_price=body.existing_avg_price,
                cost=CostModel(
                    commission_per_trade=cm.commission_per_trade,
                    commission_per_share=cm.commission_per_share,
                    slippage_bps=cm.slippage_bps,
                    min_commission=cm.min_commission,
                ),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        sim = simulate_order(req)
        return PretradeOut(**sim.to_dict())

    @app.post("/execution/simulate", response_model=ExecReportOut,
              dependencies=[Depends(require_api_key)])
    def execution_simulate_endpoint(body: ExecSimulateIn):
        try:
            schedule = ScheduleKind(body.order.schedule.lower())
        except ValueError:
            raise HTTPException(400, "schedule must be twap, vwap, or pov")
        try:
            order = ParentOrder(
                ticker=body.order.ticker, side=body.order.side,
                shares=body.order.shares,
                arrival_price=body.order.arrival_price,
                schedule=schedule,
                expected_curve=(tuple(body.order.expected_curve)
                                if body.order.expected_curve else None),
                participation_rate=body.order.participation_rate,
                max_participation=body.order.max_participation,
                base_slippage_bps=body.order.base_slippage_bps,
                slippage_bps_per_pct_adv=body.order.slippage_bps_per_pct_adv,
                commission_per_share=body.order.commission_per_share,
            )
            bars = [IntradayBar(index=b.index, price=b.price, volume=b.volume)
                    for b in body.bars]
            if not bars:
                raise ValueError("bars must be non-empty")
            rep = exec_simulate(order, bars)
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = rep.to_dict()
        return ExecReportOut(**d)

    @app.get("/ledger/{account}", response_model=LedgerListOut,
             dependencies=[Depends(require_api_key)])
    def ledger_list(account: str):
        es = ledger_store.entries(account)
        return LedgerListOut(
            account=account,
            entries=[LedgerEntryOut(**e.to_dict()) for e in es],
        )

    @app.post("/ledger/{account}", response_model=LedgerEntryOut,
              dependencies=[Depends(require_api_key)])
    def ledger_append(account: str, body: LedgerEntryIn):
        try:
            kind = EntryKind(body.kind.lower())
        except ValueError:
            raise HTTPException(400, f"invalid kind: {body.kind}")
        entry = LedgerEntry(
            ts=body.ts, kind=kind, amount=body.amount,
            ticker=body.ticker, shares=body.shares,
            price=body.price, note=body.note,
        )
        ledger_store.append(account, entry)
        return LedgerEntryOut(**entry.to_dict())

    @app.get("/ledger/{account}/snapshot", response_model=AccountSnapshotOut,
             dependencies=[Depends(require_api_key)])
    def ledger_snapshot_endpoint(account: str, marks: str | None = None):
        # marks is a comma-separated TICKER:PRICE list
        mark_map: dict[str, float] = {}
        if marks:
            for part in marks.split(","):
                part = part.strip()
                if not part or ":" not in part:
                    continue
                t, p = part.split(":", 1)
                try:
                    mark_map[t.strip().upper()] = float(p)
                except ValueError:
                    raise HTTPException(400, f"invalid mark: {part}")
        state = ledger_store.state(account)
        snap = ledger_snapshot(state, mark_map or None)
        return AccountSnapshotOut(account=account, **snap.to_dict())

    @app.put("/ledger/{account}/config", response_model=MarginConfigOut,
             dependencies=[Depends(require_api_key)])
    def ledger_set_config(account: str, body: MarginConfigIn):
        try:
            cfg = MarginConfig(
                initial_margin=body.initial_margin,
                maintenance_margin=body.maintenance_margin,
                annual_interest_rate=body.annual_interest_rate,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        ledger_store.set_config(account, cfg)
        return MarginConfigOut(
            initial_margin=cfg.initial_margin,
            maintenance_margin=cfg.maintenance_margin,
            annual_interest_rate=cfg.annual_interest_rate,
        )

    @app.get("/quality/anomalies/{ticker}", response_model=AnomalyReportOut,
             dependencies=[Depends(require_api_key)])
    def quality_anomalies(ticker: str,
                           z_threshold: float = 6.0,
                           atr_mult_threshold: float = 5.0,
                           iqr_mult_threshold: float = 4.0):
        df = load_ohlcv(ticker)
        if df is None or df.empty:
            raise HTTPException(404, f"no OHLCV cached for {ticker}")
        try:
            cfg = DetectorConfig(
                z_threshold=z_threshold,
                atr_mult_threshold=atr_mult_threshold,
                iqr_mult_threshold=iqr_mult_threshold,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        rep = detect_anomalies(df, cfg)
        return AnomalyReportOut(
            ticker=ticker.upper(),
            n_bars=rep.n_bars,
            n_anomalous=rep.n_anomalous,
            rate=rep.rate,
            anomalies=[AnomalyOut(**a.to_dict()) for a in rep.anomalies],
        )

    def _plan_to_out(p: ScalingPlan) -> ScalingPlanOut:
        return ScalingPlanOut(
            plan_id=p.plan_id, ticker=p.ticker,
            entry=p.entry, initial_stop=p.initial_stop,
            initial_shares=p.initial_shares,
            status=p.status.value, triggered=list(p.triggered),
            rungs=[ScaleRungIn(
                r_multiple=r.r_multiple, action=r.action.value,
                size_fraction=r.size_fraction, new_stop_r=r.new_stop_r,
            ) for r in p.rungs],
        )

    @app.get("/scaling/plans", response_model=ScalingPlanListOut,
             dependencies=[Depends(require_api_key)])
    def scaling_list():
        return ScalingPlanListOut(plans=[_plan_to_out(p)
                                          for p in scaling_store.list()])

    @app.post("/scaling/plans", response_model=ScalingPlanOut,
              dependencies=[Depends(require_api_key)])
    def scaling_create(body: ScalingPlanIn):
        try:
            rungs = [ScaleRung(
                r_multiple=r.r_multiple,
                action=ScaleAction(r.action.lower()),
                size_fraction=r.size_fraction,
                new_stop_r=r.new_stop_r,
            ) for r in body.rungs]
            plan = ScalingPlan(
                ticker=body.ticker, entry=body.entry,
                initial_stop=body.initial_stop,
                initial_shares=body.initial_shares,
                rungs=rungs,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        scaling_store.upsert(plan)
        return _plan_to_out(plan)

    @app.delete("/scaling/plans/{plan_id}",
                dependencies=[Depends(require_api_key)])
    def scaling_delete(plan_id: str):
        if not scaling_store.delete(plan_id):
            raise HTTPException(404, "plan not found")
        return {"ok": True}

    @app.post("/scaling/plans/{plan_id}/cancel", response_model=ScalingPlanOut,
              dependencies=[Depends(require_api_key)])
    def scaling_cancel(plan_id: str):
        if not scaling_store.cancel(plan_id):
            raise HTTPException(404, "plan not found")
        return _plan_to_out(scaling_store.get(plan_id))

    @app.post("/scaling/plans/{plan_id}/evaluate",
              response_model=ScaleEvaluateOut,
              dependencies=[Depends(require_api_key)])
    def scaling_evaluate(plan_id: str, body: ScaleEvaluateIn):
        plan = scaling_store.get(plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        try:
            bars = [PriceBar(index=b.index, high=b.high, low=b.low)
                    for b in body.bars]
        except ValueError as e:
            raise HTTPException(400, str(e))
        events, new_plan = evaluate_plan(plan, bars)
        scaling_store.upsert(new_plan)
        return ScaleEvaluateOut(
            plan=_plan_to_out(new_plan),
            events=[ScaleEventOut(**e.to_dict()) for e in events],
        )

    @app.get("/rotation", response_model=RotationOut,
             dependencies=[Depends(require_api_key)])
    def rotation_endpoint(benchmark: str = "SPY",
                          lookback_short: int = 21,
                          lookback_mid: int = 63,
                          lookback_long: int = 126,
                          tickers: str | None = None):
        if tickers:
            tlist = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        else:
            tlist = store.list()
        if benchmark not in tlist:
            tlist = list(tlist) + [benchmark]
        closes = _gather_closes(tlist)
        if benchmark not in closes:
            raise HTTPException(404, f"benchmark {benchmark} unavailable")
        try:
            rep = sector_rotation(
                closes, benchmark=benchmark,
                lookbacks=(lookback_short, lookback_mid, lookback_long),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = rep.to_dict()
        return RotationOut(**d)

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

    @app.get("/portfolio/tax", response_model=TaxReportOut, dependencies=[Depends(require_api_key)])
    def portfolio_tax(method: str = "fifo", wash_window: int = 30):
        try:
            m = LotMethod(method.lower())
        except ValueError:
            raise HTTPException(400, f"unknown method {method}")
        trades = portfolio_store.trades()
        rep = tax_summary(trades, method=m, wash_window=wash_window)
        return TaxReportOut(**rep.to_dict())

    @app.get("/optimize/{ticker}", response_model=OptResultOut, dependencies=[Depends(require_api_key)])
    def optimize(ticker: str, train: int = 252, test: int = 63,
                 refresh: bool = False):
        t = ticker.upper()
        df = load_ohlcv(t)
        if df.empty or refresh:
            df = fetch_ohlcv(t, period="5y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        try:
            res = walk_forward_optimize(df["close"], train_window=train,
                                        test_window=test)
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = res.to_dict()
        # tuples come back as lists when serialized
        d["ticker"] = t
        return OptResultOut(**d)

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

    @app.get("/webhooks", response_model=WebhookListOut, dependencies=[Depends(require_api_key)])
    def webhooks_list():
        return WebhookListOut(subscriptions=[WebhookOut(**s.to_dict())
                                             for s in webhooks_store.list()])

    @app.post("/webhooks", response_model=WebhookOut, dependencies=[Depends(require_api_key)])
    def webhooks_add(body: WebhookIn):
        if not body.url.startswith(("http://", "https://")):
            raise HTTPException(400, "url must be http(s)")
        bad = [e for e in body.events if e and e not in EVENT_KINDS]
        if bad:
            raise HTTPException(400, f"unknown event(s): {bad}")
        sub = WebhookSubscription(
            url=body.url,
            events=list(body.events) if body.events else sorted(EVENT_KINDS),
            tickers=[t.upper() for t in body.tickers],
            secret=body.secret,
            enabled=body.enabled,
        )
        webhooks_store.add(sub)
        return WebhookOut(**sub.to_dict())

    @app.delete("/webhooks/{sub_id}", dependencies=[Depends(require_api_key)])
    def webhooks_remove(sub_id: str):
        if not webhooks_store.remove(sub_id):
            raise HTTPException(404, "subscription not found")
        return {"removed": sub_id}

    @app.post("/webhooks/fire/latest", response_model=WebhookDeliveryOut,
              dependencies=[Depends(require_api_key)])
    def webhooks_fire_latest():
        latest = archive.latest()
        if latest is None:
            raise HTTPException(404, "no archived reports")
        prior = archive.prior_of(latest.as_of)
        events = diff_picks(
            current=[p.to_dict() for p in latest.picks],
            prior=[p.to_dict() for p in prior.picks] if prior else None,
            current_as_of=latest.as_of,
            prior_as_of=prior.as_of if prior else None,
        )
        deliveries = deliver_events(events, webhooks_store)
        return WebhookDeliveryOut(
            events=[PickEventOut(**e.to_dict()) for e in events],
            deliveries=deliveries,
        )

    def _drawdown_price_history():
        hist = {}
        for tk in set(t.ticker for t in portfolio_store.trades()):
            df = load_ohlcv(tk)
            if not df.empty:
                hist[tk] = df
        return hist

    @app.get("/portfolio/drawdown", response_model=DrawdownReportOut,
             dependencies=[Depends(require_api_key)])
    def portfolio_drawdown(trigger: float = 0.10, rearm: float = 0.05,
                            min_history_days: int = 5, cash: float = 0.0,
                            persist: bool = False):
        try:
            cfg = DrawdownConfig(trigger=trigger, rearm=rearm,
                                  min_history_days=min_history_days)
        except ValueError as e:
            raise HTTPException(400, str(e))
        trades = portfolio_store.trades()
        if not trades:
            raise HTTPException(404, "no trades")
        report = evaluate_guard(
            trades, _drawdown_price_history(), cfg,
            previously_tripped=drawdown_store.previously_tripped(),
            cash=cash,
        )
        if persist:
            drawdown_store.record(report.state)
        return DrawdownReportOut(**report.to_dict())

    @app.get("/portfolio/drawdown/history", dependencies=[Depends(require_api_key)])
    def portfolio_drawdown_history():
        return {"history": drawdown_store.history()}
    @app.post("/portfolio/drawdown/clear", dependencies=[Depends(require_api_key)])
    def portfolio_drawdown_clear():
        drawdown_store.clear()
        return {"ok": True}

    @app.get("/picks/guarded", response_model=DailyReportOut,
             dependencies=[Depends(require_api_key)])
    def picks_guarded(refresh: bool = False, trigger: float = 0.10,
                       rearm: float = 0.05, min_history_days: int = 5,
                       cash: float = 0.0):
        rep = run_daily(store.list(), refresh=refresh)
        trades = portfolio_store.trades()
        if trades:
            try:
                cfg = DrawdownConfig(trigger=trigger, rearm=rearm,
                                      min_history_days=min_history_days)
            except ValueError as e:
                raise HTTPException(400, str(e))
            report = evaluate_guard(
                trades, _drawdown_price_history(), cfg,
                previously_tripped=drawdown_store.previously_tripped(),
                cash=cash,
            )
            pick_dicts = drawdown_filter_picks(
                [p.to_dict() for p in rep.picks], report.state,
            )
            return DailyReportOut(
                as_of=rep.as_of,
                picks=[Pick(**p) for p in pick_dicts],
            )
        return DailyReportOut(as_of=rep.as_of,
                                picks=[Pick(**p.to_dict()) for p in rep.picks])

    @app.get("/journal", response_model=JournalListOut,
             dependencies=[Depends(require_api_key)])
    def journal_list(tag: str | None = None,
                     min_conviction: int | None = None,
                     max_conviction: int | None = None):
        rows = journal_store.list(tag=tag, min_conviction=min_conviction,
                                    max_conviction=max_conviction)
        return JournalListOut(entries=[JournalEntryOut(**e.to_dict()) for e in rows])

    @app.post("/journal", response_model=JournalEntryOut,
              dependencies=[Depends(require_api_key)])
    def journal_upsert(body: JournalEntryIn):
        # Verify trade exists
        if not any(t.id == body.trade_id for t in portfolio_store.trades()):
            raise HTTPException(404, f"trade {body.trade_id} not found")
        try:
            entry = JournalEntry(
                trade_id=body.trade_id,
                thesis=body.thesis,
                conviction=body.conviction,
                tags=list(body.tags),
                exit_reason=body.exit_reason,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        stored = journal_store.upsert(entry)
        return JournalEntryOut(**stored.to_dict())

    @app.get("/journal/stats/conviction", response_model=ConvictionStatsOut,
             dependencies=[Depends(require_api_key)])
    def journal_conviction_stats():
        buckets = conviction_stats(portfolio_store.trades(), journal_store.list())
        return ConvictionStatsOut(
            buckets=[ConvictionBucketOut(**b.to_dict()) for b in buckets],
        )

    @app.get("/journal/{trade_id}", response_model=JournalEntryOut,
             dependencies=[Depends(require_api_key)])
    def journal_get(trade_id: str):
        e = journal_store.get(trade_id)
        if e is None:
            raise HTTPException(404, "journal entry not found")
        return JournalEntryOut(**e.to_dict())

    @app.delete("/journal/{trade_id}", dependencies=[Depends(require_api_key)])
    def journal_remove(trade_id: str):
        if not journal_store.remove(trade_id):
            raise HTTPException(404, "journal entry not found")
        return {"removed": trade_id}

    @app.get("/brackets", response_model=BracketListOut,
             dependencies=[Depends(require_api_key)])
    def brackets_list(ticker: str | None = None, status: str | None = None):
        try:
            rows = bracket_store.list(ticker=ticker, status=status)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketListOut(plans=[BracketPlanOut(**p.to_dict()) for p in rows])

    @app.post("/brackets", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_create(body: BracketPlanIn):
        try:
            plan = BracketPlan(
                ticker=body.ticker, side=body.side, entry=body.entry,
                stop=body.stop, target=body.target, shares=body.shares,
                note=body.note,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        bracket_store.add(plan)
        return BracketPlanOut(**plan.to_dict())

    @app.get("/brackets/stats", response_model=BracketStatsOut,
             dependencies=[Depends(require_api_key)])
    def brackets_stats_ep():
        stats = compute_bracket_stats(bracket_store.list())
        return BracketStatsOut(**stats.to_dict())

    @app.get("/brackets/{plan_id}", response_model=BracketPlanOut,
             dependencies=[Depends(require_api_key)])
    def brackets_get(plan_id: str):
        p = bracket_store.get(plan_id)
        if p is None:
            raise HTTPException(404, "bracket plan not found")
        return BracketPlanOut(**p.to_dict())

    @app.delete("/brackets/{plan_id}", dependencies=[Depends(require_api_key)])
    def brackets_remove(plan_id: str):
        if not bracket_store.remove(plan_id):
            raise HTTPException(404, "bracket plan not found")
        return {"removed": plan_id}

    @app.post("/brackets/{plan_id}/fill", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_fill_ep(plan_id: str, body: BracketFillIn):
        try:
            p = bracket_store.fill(plan_id, actual_entry=body.actual_entry)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.post("/brackets/{plan_id}/close", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_close_ep(plan_id: str, body: BracketCloseIn):
        try:
            p = bracket_store.close(plan_id, actual_exit=body.actual_exit, reason=body.reason)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.post("/brackets/{plan_id}/cancel", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_cancel_ep(plan_id: str):
        try:
            p = bracket_store.cancel(plan_id)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.get("/fx", response_model=FxListOut, dependencies=[Depends(require_api_key)])
    def fx_list():
        return FxListOut(currencies=fx_store.currencies())

    @app.post("/fx", response_model=FxRateOut, dependencies=[Depends(require_api_key)])
    def fx_upsert(body: FxRateIn):
        cur = body.currency.upper().strip()
        if len(cur) != 3 or not cur.isalpha():
            raise HTTPException(400, "currency must be 3-letter ISO code")
        if body.rate <= 0:
            raise HTTPException(400, "rate must be positive")
        fx_store.upsert_rate(cur, body.date, body.rate)
        return FxRateOut(currency=cur, date=body.date, rate=body.rate)

    @app.get("/fx/{currency}", response_model=FxRateOut,
             dependencies=[Depends(require_api_key)])
    def fx_get(currency: str, as_of: str):
        rate = fx_store.get(currency, as_of)
        if rate is None:
            raise HTTPException(404, f"no rate for {currency} as of {as_of}")
        return FxRateOut(currency=currency.upper(), date=as_of, rate=rate)

    @app.get("/portfolio/currency", response_model=TradeCurrencyOut,
             dependencies=[Depends(require_api_key)])
    def trade_currency_list():
        return TradeCurrencyOut(map=ccy_map.all())

    @app.post("/portfolio/currency", response_model=TradeCurrencyOut,
              dependencies=[Depends(require_api_key)])
    def trade_currency_set(body: TradeCurrencyIn):
        if not any(t.id == body.trade_id for t in portfolio_store.trades()):
            raise HTTPException(404, f"trade {body.trade_id} not found")
        try:
            ccy_map.set(body.trade_id, body.currency)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return TradeCurrencyOut(map=ccy_map.all())

    @app.delete("/portfolio/currency/{trade_id}",
                dependencies=[Depends(require_api_key)])
    def trade_currency_remove(trade_id: str):
        if not ccy_map.remove(trade_id):
            raise HTTPException(404, "trade currency not set")
        return {"removed": trade_id}

    @app.get("/portfolio/converted", response_model=ConvertedTradesOut,
             dependencies=[Depends(require_api_key)])
    def portfolio_converted(base: str = "USD"):
        if base.upper() != USD:
            raise HTTPException(400, "only USD base currency supported")
        trades = portfolio_store.trades()
        audits = convert_trades(trades, ccy_map, fx_store, base=USD)
        rows = [audit.to_dict() for audit in audits.values()]
        total_base = sum(a["base_amount"] or 0.0 for a in rows)
        total_fallback = sum(a["native_amount"] for a in rows if a["fallback"])
        return ConvertedTradesOut(
            base=USD,
            audits=[ConversionAuditOut(**a) for a in rows],
            total_base_cost=total_base,
            total_fallback_native=total_fallback,
        )

    @app.get("/notifier/dlq", response_model=DeadLetterListOut,
             dependencies=[Depends(require_api_key)])
    def dlq_list(channel: str | None = None):
        items = dlq.list(channel=channel)
        return DeadLetterListOut(items=[DeadLetterOut(**i.to_dict()) for i in items])

    @app.delete("/notifier/dlq/{item_id}", dependencies=[Depends(require_api_key)])
    def dlq_remove(item_id: str):
        if not dlq.remove(item_id):
            raise HTTPException(404, "item not found")
        return {"removed": item_id}

    @app.post("/notifier/dlq/replay", response_model=DlqReplayOut,
              dependencies=[Depends(require_api_key)])
    def dlq_replay():
        counts = replay_dlq(
            dlq, _notifier_for,
            policy=RetryPolicy(max_attempts=2, initial_delay=0.5, jitter=0.0),
        )
        return DlqReplayOut(**counts)

    @app.post("/notifier/test", dependencies=[Depends(require_api_key)])
    def notifier_test(body: NotifyTestIn):
        n = _notifier_for(body.channel)
        if n is None:
            raise HTTPException(400,
                                  f"unknown channel '{body.channel}'")
        ok = send_with_retry(
            n, body.text, channel=body.channel.lower(),
            policy=RetryPolicy(max_attempts=2, initial_delay=0, jitter=0.0),
            dlq=dlq,
        )
        return {"channel": body.channel.lower(), "ok": ok}

    return app


app = create_app()
