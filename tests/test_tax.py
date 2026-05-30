from signalclaw.portfolio import (
    Trade, TradeSide, LotMethod, compute_realized, detect_wash_sales,
    tax_summary,
)
from signalclaw.portfolio.position import apply_trades


def _t(side, qty, price, date, fees=0.0, ticker="AAPL", tid=None):
    tr = Trade(ticker=ticker, side=TradeSide(side), quantity=qty,
               price=price, date=date, fees=fees)
    if tid:
        tr.id = tid
    return tr


def test_fifo_matches_apply_trades():
    trades = [
        _t("buy", 10, 100, "2024-01-01", tid="b1"),
        _t("buy", 10, 120, "2024-02-01", tid="b2"),
        _t("sell", 15, 130, "2024-03-01", tid="s1"),
    ]
    rep = compute_realized(trades, method=LotMethod.FIFO)
    # FIFO: 10 @ 100 + 5 @ 120 -> (130-100)*10 + (130-120)*5 = 300 + 50 = 350
    assert abs(rep.realized_total - 350.0) < 1e-9
    # Same as apply_trades realized_pnl on the sell
    apply_trades(trades)
    sell = [t for t in trades if t.id == "s1"][0]
    assert abs(sell.realized_pnl - 350.0) < 1e-9


def test_lifo_uses_recent_lots_first():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("buy", 10, 120, "2024-02-01"),
        _t("sell", 15, 130, "2024-03-01"),
    ]
    rep = compute_realized(trades, method=LotMethod.LIFO)
    # LIFO: 10 @ 120 + 5 @ 100 -> 100 + 150 = 250
    assert abs(rep.realized_total - 250.0) < 1e-9


def test_hifo_picks_highest_cost():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("buy", 10, 150, "2024-02-01"),  # highest cost
        _t("buy", 10, 120, "2024-03-01"),
        _t("sell", 10, 160, "2024-04-01"),
    ]
    rep = compute_realized(trades, method=LotMethod.HIFO)
    # HIFO consumes the 150-cost lot first -> (160-150)*10 = 100
    assert abs(rep.realized_total - 100.0) < 1e-9


def test_avgco_rolling_average():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),  # avg 100
        _t("buy", 10, 200, "2024-02-01"),  # avg 150
        _t("sell", 10, 250, "2024-03-01"),
    ]
    rep = compute_realized(trades, method=LotMethod.AVGCO)
    # avg cost 150, sell 250 x 10 -> 1000
    assert abs(rep.realized_total - 1000.0) < 1e-9
    # Long-term split unavailable for avgco
    assert rep.realized_long_term == 0.0
    assert rep.realized_short_term == 0.0


def test_long_term_classification():
    trades = [
        _t("buy", 10, 100, "2023-01-01"),
        _t("sell", 10, 150, "2024-06-01"),   # >365d -> long
    ]
    rep = compute_realized(trades, method=LotMethod.FIFO)
    assert rep.events[0].long_term is True
    assert rep.realized_long_term == 500.0
    assert rep.realized_short_term == 0.0


def test_short_term_classification():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("sell", 10, 90, "2024-02-01"),    # loss, short-term
    ]
    rep = compute_realized(trades, method=LotMethod.FIFO)
    assert rep.events[0].long_term is False
    assert rep.realized_short_term == -100.0


def test_wash_sale_detected_within_window():
    trades = [
        _t("buy", 10, 100, "2024-01-01", tid="b1"),
        _t("sell", 10, 90, "2024-02-01", tid="s1"),  # loss -100
        _t("buy", 10, 95, "2024-02-15", tid="b2"),   # within 30d -> wash
    ]
    flags = detect_wash_sales(trades, window_days=30)
    assert len(flags) == 1
    assert flags[0].sell_trade_id == "s1"
    assert flags[0].triggering_buy_id == "b2"
    assert flags[0].days_between == 14


def test_no_wash_sale_outside_window():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("sell", 10, 90, "2024-02-01"),
        _t("buy", 10, 95, "2024-04-15"),    # > 30d
    ]
    assert detect_wash_sales(trades, window_days=30) == []


def test_no_wash_sale_on_gain():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("sell", 10, 150, "2024-02-01"),  # gain
        _t("buy", 10, 145, "2024-02-15"),
    ]
    assert detect_wash_sales(trades) == []


def test_tax_summary_combines():
    trades = [
        _t("buy", 10, 100, "2024-01-01"),
        _t("sell", 10, 90, "2024-02-01"),
        _t("buy", 10, 95, "2024-02-10"),
    ]
    rep = tax_summary(trades, method=LotMethod.FIFO)
    assert rep.realized_total == -100.0
    assert len(rep.wash_sales) == 1
