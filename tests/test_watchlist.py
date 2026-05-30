from signalclaw.data.universe import WatchlistStore, default_watchlist


def test_default():
    assert "MSFT" in default_watchlist()


def test_add_remove(tmp_path):
    store = WatchlistStore(tmp_path / "wl.json")
    store.add("NVDA")
    assert "NVDA" in store.list()
    store.remove("NVDA")
    assert "NVDA" not in store.list()
