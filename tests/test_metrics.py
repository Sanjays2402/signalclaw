import pandas as pd
from signalclaw.backtest.metrics import sharpe, sortino, max_drawdown, hit_rate, cagr


def test_metrics_smoke():
    r = pd.Series([0.01, -0.02, 0.005, 0.01, -0.005, 0.02])
    eq = (1 + r).cumprod()
    assert isinstance(sharpe(r), float)
    assert isinstance(sortino(r), float)
    assert max_drawdown(eq) <= 0
    assert 0 <= hit_rate(r) <= 1
    assert isinstance(cagr(eq), float)
