from signalclaw.portfolio import sector_exposure, classify, DEFAULT_SECTOR_MAP


def test_classify_known_ticker():
    assert classify("AAPL") == "Technology"
    assert classify("xom") == "Energy"
    assert classify("ZZZZ") == "Unknown"


def test_classify_overrides_win():
    assert classify("AAPL", overrides={"AAPL": "Custom"}) == "Custom"


def test_sector_exposure_buckets_and_hhi():
    weights = {"AAPL": 0.30, "MSFT": 0.20, "JPM": 0.30, "XOM": 0.20}
    mv = {"AAPL": 30.0, "MSFT": 20.0, "JPM": 30.0, "XOM": 20.0}
    rep = sector_exposure(weights, market_values=mv)
    sectors = {s.sector: s for s in rep.sectors}
    assert sectors["Technology"].weight == 0.5
    assert sectors["Financials"].weight == 0.30
    assert sectors["Energy"].weight == 0.20
    # HHI = 0.5^2 + 0.3^2 + 0.2^2 = 0.38
    assert abs(rep.hhi - 0.38) < 1e-9
    assert abs(rep.effective_n_sectors - (1 / 0.38)) < 1e-9
    assert rep.max_sector == "Technology"
    assert rep.total_market_value == 100.0


def test_sector_exposure_breaches_caps():
    weights = {"AAPL": 0.50, "MSFT": 0.20, "JPM": 0.30}
    rep = sector_exposure(weights, sector_cap=0.35, position_cap=0.40)
    # Tech sector = 0.70 > 0.35 -> breach
    # AAPL position 0.50 > 0.40 -> breach
    assert any("Technology" in b for b in rep.breaches)
    assert any("AAPL" in b for b in rep.breaches)


def test_sector_exposure_unknown_warning():
    weights = {"ZZZZ": 1.0}
    rep = sector_exposure(weights)
    assert "ZZZZ" in rep.unknown_tickers
    assert any("unclassified" in w for w in rep.warnings)


def test_sector_exposure_empty():
    rep = sector_exposure({})
    assert rep.sectors == []
    assert rep.hhi == 0.0
    assert rep.max_position is None


def test_high_hhi_warning():
    rep = sector_exposure({"AAPL": 0.80, "MSFT": 0.20})
    # all Technology -> HHI = 1.0 -> warning
    assert rep.hhi == 1.0
    assert any("HHI" in w for w in rep.warnings)
