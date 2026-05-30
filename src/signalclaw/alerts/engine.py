"""Alert evaluation engine.

Evaluates a list of Alert rules against a snapshot of market data and
optional signal labels. Pure function plus optional dispatcher.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional

import pandas as pd

from ..logging_ import get_logger
from ..features import rsi as rsi_indicator
from .rules import Alert, AlertCondition, AlertHit
from .store import AlertStore

log = get_logger(__name__)


def _latest_price(df: pd.DataFrame) -> Optional[float]:
    if df is None or df.empty or "close" not in df.columns:
        return None
    return float(df["close"].iloc[-1])


def _pct_change_1d(df: pd.DataFrame) -> Optional[float]:
    if df is None or len(df) < 2 or "close" not in df.columns:
        return None
    a = float(df["close"].iloc[-2])
    b = float(df["close"].iloc[-1])
    if a == 0:
        return None
    return (b - a) / a


def _latest_rsi(df: pd.DataFrame, period: int = 14) -> Optional[float]:
    if df is None or len(df) < period + 2:
        return None
    try:
        series = rsi_indicator(df["close"], n=period).dropna()
        if series.empty:
            return None
        return float(series.iloc[-1])
    except Exception:
        return None


def _check(alert: Alert, observed: float | str) -> bool:
    cond = alert.condition
    try:
        if cond == AlertCondition.PRICE_ABOVE:
            return float(observed) > float(alert.value)
        if cond == AlertCondition.PRICE_BELOW:
            return float(observed) < float(alert.value)
        if cond == AlertCondition.PCT_CHANGE_ABOVE:
            return float(observed) > float(alert.value)
        if cond == AlertCondition.PCT_CHANGE_BELOW:
            return float(observed) < float(alert.value)
        if cond == AlertCondition.RSI_ABOVE:
            return float(observed) > float(alert.value)
        if cond == AlertCondition.RSI_BELOW:
            return float(observed) < float(alert.value)
        if cond == AlertCondition.SIGNAL_LABEL:
            return str(observed).lower() == str(alert.value).lower()
    except (TypeError, ValueError):
        return False
    return False


def evaluate_alerts(
    alerts: Iterable[Alert],
    ohlcv_by_ticker: Dict[str, pd.DataFrame],
    signal_labels: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
    update_cooldown: bool = True,
) -> List[AlertHit]:
    """Evaluate alerts and return list of new hits.

    Mutates alert.last_fired_at when a hit is recorded (unless update_cooldown=False).
    Skips alerts in cooldown or disabled.
    """
    now = now or datetime.now(timezone.utc)
    signal_labels = signal_labels or {}
    hits: List[AlertHit] = []

    for alert in alerts:
        if not alert.enabled or alert.in_cooldown(now):
            continue
        df = ohlcv_by_ticker.get(alert.ticker.upper())
        observed: float | str | None = None
        cond = alert.condition

        if cond in (AlertCondition.PRICE_ABOVE, AlertCondition.PRICE_BELOW):
            observed = _latest_price(df) if df is not None else None
        elif cond in (AlertCondition.PCT_CHANGE_ABOVE, AlertCondition.PCT_CHANGE_BELOW):
            observed = _pct_change_1d(df) if df is not None else None
        elif cond in (AlertCondition.RSI_ABOVE, AlertCondition.RSI_BELOW):
            observed = _latest_rsi(df) if df is not None else None
        elif cond == AlertCondition.SIGNAL_LABEL:
            observed = signal_labels.get(alert.ticker.upper())

        if observed is None:
            continue
        if not _check(alert, observed):
            continue

        hit = AlertHit(
            alert_id=alert.id,
            ticker=alert.ticker,
            condition=cond.value,
            value=alert.value,
            observed=observed,
            fired_at=now.isoformat(),
            note=alert.note,
        )
        hits.append(hit)
        if update_cooldown:
            alert.last_fired_at = now.isoformat()
        log.info("alert.hit", ticker=alert.ticker, condition=cond.value,
                 value=alert.value, observed=observed)

    return hits


def dispatch_hits(hits: List[AlertHit], notifiers: Iterable) -> int:
    """Send each hit through every notifier. Returns count of successful sends."""
    sent = 0
    for hit in hits:
        text = hit.format()
        for n in notifiers:
            try:
                if n.send(text):
                    sent += 1
            except Exception as e:  # noqa
                log.warning("alert.dispatch.fail", err=str(e), notifier=type(n).__name__)
    return sent


def dispatch_hits_with_retry(
    hits: List[AlertHit],
    notifiers_by_channel,  # dict[str, Notifier]
    *,
    policy=None,
    dlq=None,
) -> dict:
    """Send each hit through every notifier using send_with_retry.

    `notifiers_by_channel` maps channel name (e.g. 'slack', 'telegram') to a
    Notifier instance. On final failure the message is enqueued to `dlq`.
    Returns counts {sent, failed}.
    """
    from ..notifier import send_with_retry, RetryPolicy
    p = policy or RetryPolicy()
    sent = 0
    failed = 0
    for hit in hits:
        text = hit.format()
        for channel, n in notifiers_by_channel.items():
            ok = send_with_retry(n, text, channel=channel, policy=p, dlq=dlq)
            if ok:
                sent += 1
            else:
                failed += 1
    return {"sent": sent, "failed": failed}


def evaluate_with_store(
    store: AlertStore,
    ohlcv_by_ticker: Dict[str, pd.DataFrame],
    signal_labels: Optional[Dict[str, str]] = None,
    now: Optional[datetime] = None,
) -> List[AlertHit]:
    """Convenience: load alerts from store, evaluate, persist updated cooldown."""
    alerts = store.list()
    hits = evaluate_alerts(alerts, ohlcv_by_ticker, signal_labels=signal_labels, now=now)
    for a in alerts:
        store.update(a)
    return hits
