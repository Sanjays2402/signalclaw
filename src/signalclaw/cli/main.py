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


def main():
    cli()


if __name__ == "__main__":
    main()
