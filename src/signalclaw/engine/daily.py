from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import date
from typing import List
import pandas as pd

from ..config import get_settings
from ..logging_ import get_logger
from ..data import default_watchlist, fetch_ohlcv, load_ohlcv, save_ohlcv, fetch_rss
from ..features import build_features
from ..models import WatchHoldSkipClassifier, ReturnRegressor, Ensemble, make_labels
from ..sentiment import SentimentScorer
from ..explain import rationale_for, risk_flags

log = get_logger(__name__)


@dataclass
class DailyPick:
    ticker: str
    label: str
    score: float
    expected_return: float
    rationale: str
    risk_flags: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DailyReport:
    as_of: str
    picks: List[DailyPick] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"as_of": self.as_of, "picks": [p.to_dict() for p in self.picks]}


def _prepare_one(ticker: str, refresh: bool, scorer: SentimentScorer) -> tuple[pd.DataFrame, pd.Series]:
    df = load_ohlcv(ticker)
    if df.empty or refresh:
        df = fetch_ohlcv(ticker, period="3y")
        if not df.empty:
            save_ohlcv(ticker, df)
    sentiment = pd.Series(dtype=float)
    try:
        items = fetch_rss(ticker, limit=10)
        if items:
            scores = [scorer.score(it.title + ". " + (it.summary or "")).score for it in items]
            sentiment = pd.Series([sum(scores) / len(scores)] * len(df), index=df.index)
    except Exception as e:  # noqa
        log.warning("daily.sentiment.fail", ticker=ticker, err=str(e))
    return df, sentiment


def run_daily(tickers: List[str] | None = None, refresh: bool = True) -> DailyReport:
    s = get_settings()
    tickers = tickers or default_watchlist()
    scorer = SentimentScorer()
    picks: List[DailyPick] = []
    for t in tickers:
        try:
            df, sentiment = _prepare_one(t, refresh, scorer)
            if df.empty or len(df) < 300:
                log.warning("daily.skip.short", ticker=t, n=len(df))
                continue
            feats = build_features(df, sentiment=sentiment)
            labels = make_labels(df["close"], horizon=5)
            joined = feats.join(labels, how="inner").dropna()
            if len(joined) < 200:
                continue
            feat_cols = [c for c in joined.columns if c not in ("label", "fwd_ret")]
            train = joined.iloc[:-1]
            clf = WatchHoldSkipClassifier().fit(train[feat_cols], train["label"])
            reg = ReturnRegressor().fit(train[feat_cols], train["fwd_ret"])
            ens = Ensemble(clf, reg)
            last = joined.iloc[[-1]][feat_cols]
            pred = ens.predict_row(last)
            row = joined.iloc[-1]
            picks.append(DailyPick(
                ticker=t,
                label=pred.label,
                score=pred.score,
                expected_return=pred.expected_return,
                rationale=rationale_for(t, row, pred),
                risk_flags=risk_flags(row),
            ))
        except Exception as e:  # noqa
            log.warning("daily.ticker.fail", ticker=t, err=str(e))
    picks.sort(key=lambda p: p.score, reverse=True)
    return DailyReport(as_of=date.today().isoformat(), picks=picks)
