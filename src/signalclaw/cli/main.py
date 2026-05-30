from __future__ import annotations
import json
import click
from datetime import date
from rich.console import Console
from rich.table import Table

from ..config import get_settings
from ..logging_ import configure_logging
from ..data import WatchlistStore, fetch_ohlcv, save_ohlcv, load_ohlcv, default_watchlist
from ..engine import run_daily, render_markdown
from ..backtest import WalkForwardBacktest
from ..notifier import TelegramNotifier, DiscordNotifier
from ..alerts import Alert, AlertCondition, AlertStore, evaluate_alerts, dispatch_hits
from ..portfolio import (PortfolioStore, Trade, TradeSide, compute_snapshot,
                          StopRule, StopKind, StopStore, evaluate_rules)
from ..risk import RiskConfig, size_pick
from ..correlation import correlation_matrix, diversification_warnings
from ..history import ReportArchive, diff_reports

console = Console()


@click.group()
@click.option("--log-level", default=None)
def cli(log_level):
    """SignalClaw. NOT financial advice."""
    s = get_settings()
    configure_logging(log_level or s.log_level)


@cli.group()
def watchlist():
    """Manage watchlist."""


@watchlist.command("list")
def wl_list():
    s = get_settings()
    store = WatchlistStore(s.data_dir / "watchlist.json")
    for t in store.list():
        console.print(t)


@watchlist.command("add")
@click.argument("ticker")
def wl_add(ticker):
    s = get_settings()
    store = WatchlistStore(s.data_dir / "watchlist.json")
    console.print(store.add(ticker))


@watchlist.command("remove")
@click.argument("ticker")
def wl_remove(ticker):
    s = get_settings()
    store = WatchlistStore(s.data_dir / "watchlist.json")
    console.print(store.remove(ticker))


@cli.command("ingest")
@click.option("--period", default="3y")
def ingest(period):
    """Refresh OHLCV parquet for watchlist."""
    s = get_settings()
    store = WatchlistStore(s.data_dir / "watchlist.json")
    for t in store.list():
        df = fetch_ohlcv(t, period=period)
        if not df.empty:
            save_ohlcv(t, df)
            console.print(f"{t}: {len(df)} rows")
        else:
            console.print(f"{t}: NO DATA")


@cli.command("run")
@click.option("--today", "today_flag", is_flag=True)
@click.option("--notify/--no-notify", default=False)
@click.option("--out", type=click.Path(), default=None)
def run(today_flag, notify, out):
    """Run today's signal pipeline."""
    rep = run_daily()
    md = render_markdown(rep)
    console.print(md)
    # archive
    s = get_settings()
    archive = ReportArchive(s.data_dir / "reports")
    archive.save(rep)
    if out:
        from pathlib import Path
        Path(out).write_text(md)
        console.print(f"wrote {out}")
    if notify:
        TelegramNotifier().send(md)
        DiscordNotifier().send(md)


@cli.command("backtest")
@click.option("--ticker", default=None, help="single ticker; default runs whole watchlist")
@click.option("--from", "from_date", default=None)
@click.option("--period", default="3y")
def backtest(ticker, from_date, period):
    """Walk-forward backtest. Prints sharpe/sortino/MDD/hit-rate per ticker."""
    s = get_settings()
    store = WatchlistStore(s.data_dir / "watchlist.json")
    tickers = [ticker] if ticker else store.list()
    table = Table(title="SignalClaw backtest (NOT FINANCIAL ADVICE)")
    for c in ["ticker", "sharpe", "sortino", "max_dd", "hit_rate", "cagr", "trades"]:
        table.add_column(c)
    for t in tickers:
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period=period)
            if not df.empty:
                save_ohlcv(t, df)
        if from_date:
            df = df[df.index >= from_date]
        if df.empty:
            table.add_row(t, "-", "-", "-", "-", "-", "-")
            continue
        bt = WalkForwardBacktest().run(df)
        table.add_row(t, f"{bt.sharpe:.2f}", f"{bt.sortino:.2f}", f"{bt.max_drawdown:.2%}",
                      f"{bt.hit_rate:.2%}", f"{bt.cagr:.2%}", str(bt.n_trades))
    console.print(table)


@cli.command("optimize")
@click.argument("ticker")
@click.option("--train", default=252, type=int)
@click.option("--test", default=63, type=int)
@click.option("--period", default="5y")
def optimize_cmd(ticker, train, test, period):
    """Walk-forward parameter sweep for SMA crossover + RSI filter."""
    from ..backtest import walk_forward_optimize
    t = ticker.upper()
    df = load_ohlcv(t)
    if df.empty:
        df = fetch_ohlcv(t, period=period)
        if not df.empty:
            save_ohlcv(t, df)
    if df.empty or "close" not in df.columns:
        console.print(f"no data for {t}")
        return
    try:
        res = walk_forward_optimize(df["close"], train_window=train,
                                    test_window=test)
    except ValueError as e:
        console.print(f"error: {e}")
        return
    table = Table(title=f"Walk-forward optimization {t}")
    for c in ["fold", "train_end", "test_end", "params", "train_sh",
              "test_sh", "test_ret", "test_mdd"]:
        table.add_column(c)
    for i, f in enumerate(res.folds, 1):
        table.add_row(str(i), f.train_end, f.test_end, str(f.chosen),
                      f"{f.train_sharpe:.2f}", f"{f.test_sharpe:.2f}",
                      f"{f.test_return:.2%}", f"{f.test_max_drawdown:.2%}")
    console.print(table)
    console.print(f"folds {res.n_folds} | grid {res.grid_size} | "
                  f"median OOS Sharpe {res.median_test_sharpe:.2f} | "
                  f"mean OOS return {res.mean_test_return:.2%} | "
                  f"most common params {res.most_common_params} "
                  f"({res.most_common_share:.0%})")


@cli.command("serve")
@click.option("--host", default="0.0.0.0")
@click.option("--port", default=7431, type=int)
def serve(host, port):
    """Run the API server."""
    import uvicorn
    uvicorn.run("signalclaw.api:app", host=host, port=port, log_level="info")


@cli.group()
def alerts():
    """Manage price/indicator alerts."""


@alerts.command("list")
@click.option("--ticker", default=None)
def alerts_list(ticker):
    s = get_settings()
    store = AlertStore(s.data_dir / "alerts.json")
    rows = store.list(ticker=ticker)
    if not rows:
        console.print("(no alerts)")
        return
    table = Table(title="Alerts")
    for c in ["id", "ticker", "condition", "value", "enabled", "cooldown_h", "last_fired", "note"]:
        table.add_column(c)
    for a in rows:
        table.add_row(a.id, a.ticker, a.condition.value, str(a.value),
                      str(a.enabled), str(a.cooldown_hours),
                      a.last_fired_at or "-", a.note or "")
    console.print(table)


@alerts.command("add")
@click.argument("ticker")
@click.argument("condition", type=click.Choice([c.value for c in AlertCondition]))
@click.argument("value")
@click.option("--note", default="")
@click.option("--cooldown-hours", default=12, type=int)
def alerts_add(ticker, condition, value, note, cooldown_hours):
    s = get_settings()
    store = AlertStore(s.data_dir / "alerts.json")
    cond = AlertCondition(condition)
    val: float | str
    if cond == AlertCondition.SIGNAL_LABEL:
        val = str(value)
    else:
        val = float(value)
    a = Alert(ticker=ticker.upper(), condition=cond, value=val,
              note=note, cooldown_hours=cooldown_hours)
    store.add(a)
    console.print(f"added {a.id} {a.ticker} {a.condition.value} {a.value}")


@alerts.command("remove")
@click.argument("alert_id")
def alerts_remove(alert_id):
    s = get_settings()
    store = AlertStore(s.data_dir / "alerts.json")
    ok = store.remove(alert_id)
    console.print("removed" if ok else "not found")


@alerts.command("check")
@click.option("--notify/--no-notify", default=False)
def alerts_check(notify):
    """Evaluate all alerts against latest cached OHLCV."""
    s = get_settings()
    store = AlertStore(s.data_dir / "alerts.json")
    rows = store.list()
    if not rows:
        console.print("(no alerts)")
        return
    ohlcv = {}
    for t in {a.ticker for a in rows}:
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period="3mo")
            if not df.empty:
                save_ohlcv(t, df)
        ohlcv[t] = df
    hits = evaluate_alerts(rows, ohlcv)
    for a in rows:
        store.update(a)
    if not hits:
        console.print("no triggers")
        return
    for h in hits:
        console.print(h.format())
    if notify:
        sent = dispatch_hits(hits, [TelegramNotifier(), DiscordNotifier()])
        console.print(f"dispatched={sent}")


@cli.group("portfolio")
def portfolio_grp():
    """Manage trades and view positions / P&L."""


@portfolio_grp.command("add")
@click.argument("ticker")
@click.argument("side", type=click.Choice(["buy", "sell"]))
@click.argument("quantity", type=float)
@click.argument("price", type=float)
@click.option("--date", "trade_date", default=None, help="YYYY-MM-DD (default today)")
@click.option("--fees", default=0.0, type=float)
@click.option("--note", default="")
def portfolio_add(ticker, side, quantity, price, trade_date, fees, note):
    from datetime import date as _date
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    tr = Trade(ticker=ticker.upper(), side=TradeSide(side), quantity=quantity,
               price=price, date=trade_date or _date.today().isoformat(),
               fees=fees, note=note)
    pstore.add_trade(tr)
    console.print(f"added {tr.id} {tr.ticker} {tr.side.value} {tr.quantity} @ {tr.price}"
                  + (f" realized=${tr.realized_pnl:.2f}" if tr.side == TradeSide.SELL else ""))


@portfolio_grp.command("remove")
@click.argument("trade_id")
def portfolio_remove(trade_id):
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    console.print("removed" if pstore.remove_trade(trade_id) else "not found")


@portfolio_grp.command("trades")
def portfolio_trades():
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    rows = pstore.trades()
    if not rows:
        console.print("(no trades)")
        return
    table = Table(title="Trades")
    for c in ["id", "date", "ticker", "side", "qty", "price", "fees", "realized", "note"]:
        table.add_column(c)
    for t in sorted(rows, key=lambda x: x.date):
        table.add_row(t.id, t.date, t.ticker, t.side.value, f"{t.quantity:g}",
                      f"{t.price:.2f}", f"{t.fees:.2f}",
                      f"{t.realized_pnl:.2f}", t.note)
    console.print(table)


@portfolio_grp.command("import")
@click.argument("csv_path", type=click.Path(exists=True))
def portfolio_import(csv_path):
    from pathlib import Path as _P
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    n = pstore.import_csv(_P(csv_path).read_text())
    console.print(f"imported {n} trades")


@portfolio_grp.command("show")
def portfolio_show():
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    positions = pstore.positions()
    last_prices = {}
    for t in positions:
        df = load_ohlcv(t)
        if not df.empty and "close" in df.columns:
            last_prices[t] = float(df["close"].iloc[-1])
    snap = compute_snapshot(positions, last_prices, trades=pstore.trades())
    table = Table(title="Portfolio (NOT FINANCIAL ADVICE)")
    for c in ["ticker", "qty", "avg_cost", "last", "cost", "mv", "unrealized", "%", "realized", "weight"]:
        table.add_column(c)
    for p in snap.positions:
        table.add_row(
            p.ticker, f"{p.quantity:g}", f"{p.avg_cost:.2f}",
            f"{p.last_price:.2f}" if p.last_price else "-",
            f"{p.cost:.2f}", f"{p.market_value:.2f}",
            f"{p.unrealized_pnl:.2f}", f"{p.unrealized_pct:.2%}",
            f"{p.realized_pnl:.2f}",
            f"{snap.weights.get(p.ticker, 0.0):.2%}",
        )
    console.print(table)
    console.print(f"total cost ${snap.total_cost:.2f} | market value ${snap.total_market_value:.2f}"
                  f" | unrealized ${snap.total_unrealized:.2f}"
                  f" | realized ${snap.total_realized:.2f}")


@portfolio_grp.command("sectors")
@click.option("--sector-cap", default=0.35, type=float)
@click.option("--position-cap", default=0.25, type=float)
def portfolio_sectors_cmd(sector_cap, position_cap):
    """Show sector exposure, HHI concentration, and breaches."""
    from ..portfolio import sector_exposure
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    positions = pstore.positions()
    if not positions:
        console.print("no positions")
        return
    last_prices = {}
    for t in positions:
        df = load_ohlcv(t)
        if not df.empty and "close" in df.columns:
            last_prices[t] = float(df["close"].iloc[-1])
    snap = compute_snapshot(positions, last_prices, trades=pstore.trades())
    if not snap.weights:
        console.print("weights unavailable (no last prices)")
        return
    mv = {p.ticker: p.market_value for p in snap.positions}
    rep = sector_exposure(snap.weights, market_values=mv,
                          sector_cap=sector_cap, position_cap=position_cap)
    table = Table(title="Sector exposure")
    for c in ["sector", "weight", "market_value", "tickers"]:
        table.add_column(c)
    for sx in rep.sectors:
        table.add_row(sx.sector, f"{sx.weight:.2%}", f"${sx.market_value:.2f}",
                      ", ".join(sx.tickers))
    console.print(table)
    console.print(f"HHI {rep.hhi:.3f} | effective sectors {rep.effective_n_sectors:.2f} | "
                  f"max sector {rep.max_sector} {rep.max_sector_weight:.2%} | "
                  f"max position {rep.max_position} {rep.max_position_weight:.2%}")
    for b in rep.breaches:
        console.print(f"[red]BREACH[/red] {b}")
    for w in rep.warnings:
        console.print(f"[yellow]warn[/yellow] {w}")


@portfolio_grp.command("tax")
@click.option("--method", default="fifo",
              type=click.Choice(["fifo", "lifo", "hifo", "avgco"]))
@click.option("--wash-window", default=30, type=int)
def portfolio_tax_cmd(method, wash_window):
    """Realized P&L by lot method + wash-sale detection. NOT TAX ADVICE."""
    from ..portfolio import tax_summary, LotMethod
    s = get_settings()
    pstore = PortfolioStore(s.data_dir / "portfolio.json")
    rep = tax_summary(pstore.trades(), method=LotMethod(method),
                      wash_window=wash_window)
    table = Table(title=f"Realized events ({rep.method})")
    for c in ["date", "ticker", "qty", "proceeds", "cost", "P&L", "hold(d)", "LT?"]:
        table.add_column(c)
    for ev in rep.events:
        table.add_row(
            ev.sell_date, ev.ticker, f"{ev.quantity:g}",
            f"{ev.proceeds:.2f}", f"{ev.cost_basis:.2f}",
            f"{ev.realized_pnl:.2f}",
            str(ev.holding_days) if ev.holding_days is not None else "-",
            "Y" if ev.long_term else ("N" if ev.long_term is False else "-"),
        )
    console.print(table)
    console.print(f"total ${rep.realized_total:.2f} | "
                  f"short ${rep.realized_short_term:.2f} | "
                  f"long ${rep.realized_long_term:.2f}")
    if rep.wash_sales:
        console.print("[yellow]wash-sale flags[/yellow]")
        for w in rep.wash_sales:
            console.print(f"  {w.ticker} sell {w.sell_date} loss "
                          f"${w.loss:.2f} <-> buy {w.triggering_buy_date} "
                          f"({w.days_between}d)")
    console.print("[dim]NOT TAX ADVICE. Verify with a CPA.[/dim]")


@cli.command("size")
@click.argument("ticker")
@click.argument("label", type=click.Choice(["watch", "hold", "skip"]))
@click.argument("score", type=float)
@click.option("--equity", default=100_000.0, type=float)
@click.option("--risk", default=0.01, type=float, help="risk per trade as fraction of equity")
@click.option("--max-pct", default=0.20, type=float)
def size_cmd(ticker, label, score, equity, risk, max_pct):
    """Compute position size, stops, and target for a candidate pick."""
    df = load_ohlcv(ticker.upper())
    if df.empty:
        df = fetch_ohlcv(ticker.upper(), period="1y")
        if not df.empty:
            save_ohlcv(ticker.upper(), df)
    if df.empty:
        console.print("no data")
        return
    cfg = RiskConfig(equity=equity, risk_per_trade=risk, max_position_pct=max_pct)
    res = size_pick(ticker.upper(), df, label, score, cfg)
    table = Table(title=f"Position sizing: {ticker.upper()} (NOT FINANCIAL ADVICE)")
    table.add_column("field"); table.add_column("value")
    table.add_row("price", f"{res.price:.2f}")
    table.add_row("ATR(14)", f"{res.atr:.4f}")
    table.add_row("stop loss", f"{res.stop_loss:.2f}")
    table.add_row("take profit", f"{res.take_profit:.2f}")
    table.add_row("shares", str(res.shares))
    table.add_row("dollar size", f"{res.dollar_size:.2f}")
    table.add_row("weight", f"{res.weight:.2%}")
    table.add_row("risk amount", f"{res.risk_amount:.2f}")
    table.add_row("kelly suggested", f"{res.kelly_suggested:.4f}")
    table.add_row("kelly capped", f"{res.kelly_capped:.4f}")
    table.add_row("binding constraint", res.cap_reason)
    console.print(table)


@cli.command("correlation")
@click.option("--window", default=60, type=int)
@click.option("--threshold", default=0.70, type=float)
def correlation_cmd(window, threshold):
    """Show correlation matrix and diversification warnings for the watchlist."""
    s = get_settings()
    wl = WatchlistStore(s.data_dir / "watchlist.json").list()
    closes = {}
    for t in wl:
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period="1y")
            if not df.empty:
                save_ohlcv(t, df)
        if not df.empty and "close" in df.columns:
            closes[t] = df["close"]
    m = correlation_matrix(closes, window=window)
    if m.empty:
        console.print("(insufficient data)")
        return
    table = Table(title=f"Correlation (window={window})")
    table.add_column("")
    for t in m.columns:
        table.add_column(t)
    for t in m.index:
        row = [t] + [f"{m.loc[t, c]:+.2f}" for c in m.columns]
        table.add_row(*row)
    console.print(table)
    rep = diversification_warnings(closes, window=window, cluster_threshold=threshold)
    console.print(f"avg pairwise corr {rep.avg_pairwise_corr:+.2f}"
                  f" | max {rep.max_pairwise_corr:+.2f}"
                  + (f" | most correlated {rep.most_correlated_pair}" if rep.most_correlated_pair else ""))
    console.print(f"clusters (>= {threshold:.2f}): {rep.clusters}")
    if rep.warnings:
        for w in rep.warnings:
            console.print(f"[WARN] {w}")


@cli.group("history")
def history_grp():
    """Browse past daily reports and diffs."""


@history_grp.command("list")
@click.option("--limit", default=20, type=int)
def history_list(limit):
    s = get_settings()
    archive = ReportArchive(s.data_dir / "reports")
    rows = archive.summaries(limit=limit)
    if not rows:
        console.print("(no archived reports)")
        return
    table = Table(title="Report history")
    for c in ["as_of", "picks", "watch", "hold", "skip", "top"]:
        table.add_column(c)
    for r in rows:
        table.add_row(r.as_of, str(r.n_picks), str(r.n_watch),
                      str(r.n_hold), str(r.n_skip), r.top_pick or "-")
    console.print(table)


@history_grp.command("diff")
@click.option("--as-of", default=None, help="Compare this date vs prior; default latest")
@click.option("--vs", default=None, help="Compare against this specific prior date")
def history_diff(as_of, vs):
    s = get_settings()
    archive = ReportArchive(s.data_dir / "reports")
    if as_of:
        d = archive.diff_between(as_of, vs)
    else:
        d = archive.diff_latest()
    if d is None:
        console.print("(no diff available)")
        return
    console.print(f"{d.prior_as_of or 'none'} -> {d.current_as_of}")
    console.print(f"new:       {d.new_picks}")
    console.print(f"dropped:   {d.dropped_picks}")
    console.print(f"upgraded:  {d.upgraded}")
    console.print(f"downgraded:{d.downgraded}")
    console.print(f"top movers:{d.score_changes}")
    console.print(f"unchanged: {d.unchanged}")


@cli.group("stops")
def stops_grp():
    """Manage stop-loss, take-profit, and trailing-stop rules."""


@stops_grp.command("list")
def stops_list_cmd():
    s = get_settings()
    store_ = StopStore(s.data_dir / "stops.json")
    rows = store_.list()
    if not rows:
        console.print("(no stop rules)")
        return
    table = Table(title="Stop rules")
    for c in ["id", "ticker", "kind", "value", "high_water", "note"]:
        table.add_column(c)
    for r in rows:
        table.add_row(r.id, r.ticker, r.kind.value, f"{r.value:g}",
                      f"{r.high_water:.2f}" if r.high_water else "-", r.note)
    console.print(table)


@stops_grp.command("add")
@click.argument("ticker")
@click.argument("kind", type=click.Choice(["stop_loss", "take_profit", "trailing"]))
@click.argument("value", type=float)
@click.option("--note", default="")
def stops_add_cmd(ticker, kind, value, note):
    s = get_settings()
    store_ = StopStore(s.data_dir / "stops.json")
    k = StopKind(kind)
    if k == StopKind.TRAILING and not (0 < value < 1):
        console.print("trailing value must be a fraction in (0, 1)")
        return
    if k in (StopKind.STOP_LOSS, StopKind.TAKE_PROFIT) and value <= 0:
        console.print("price must be positive")
        return
    r = StopRule(ticker=ticker.upper(), kind=k, value=value, note=note)
    store_.add(r)
    console.print(f"added {r.id} {r.ticker} {r.kind.value} {r.value}")


@stops_grp.command("remove")
@click.argument("rule_id")
def stops_remove_cmd(rule_id):
    s = get_settings()
    store_ = StopStore(s.data_dir / "stops.json")
    console.print("removed" if store_.remove(rule_id) else "not found")


@stops_grp.command("check")
def stops_check_cmd():
    s = get_settings()
    store_ = StopStore(s.data_dir / "stops.json")
    rules = store_.list()
    if not rules:
        console.print("(no rules)")
        return
    prices = {}
    for r in rules:
        df = load_ohlcv(r.ticker)
        if df.empty:
            df = fetch_ohlcv(r.ticker, period="3mo")
            if not df.empty:
                save_ohlcv(r.ticker, df)
        if not df.empty and "close" in df.columns:
            prices[r.ticker] = float(df["close"].iloc[-1])
    events = evaluate_rules(rules, prices)
    for r in rules:
        if r.kind == StopKind.TRAILING:
            store_.update(r)
    if not events:
        console.print("no triggers")
        return
    for e in events:
        console.print(f"[STOP] {e.ticker} {e.kind} price={e.trigger_price:.2f}"
                      f" ref={e.reference_price:.2f}")


def main():
    cli()


if __name__ == "__main__":
    main()
