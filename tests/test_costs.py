from signalclaw.backtest.costs import TransactionCostModel


def test_costs_scale():
    c = TransactionCostModel(commission_bps=1.0, slippage_bps=5.0)
    assert abs(c.cost(1.0) - 6e-4) < 1e-9
