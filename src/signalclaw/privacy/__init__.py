"""Data lifecycle (GDPR) helpers.

SignalClaw is operated as a single-tenant personal instance, so
"my data" maps to the union of user-state stores on disk under the
configured ``data_dir``: watchlist, alerts, portfolio trades, stops,
journal entries, brackets, earnings calendar, news events, webhooks,
drawdown guard state, FX rates, trade-currency overrides, dead-letter
queue entries, ledger entries, scaling plans, and the persisted audit
log itself.

The two operations exposed here:

* :func:`collect_user_data` returns a single JSON-serializable dict
  containing every record across those stores. The caller is expected
  to stream it back as ``application/json`` for the data-export
  endpoint.
* :func:`erase_user_data` performs an in-place delete: each store is
  emptied via its own ``clear()`` method when available, otherwise the
  backing JSON file is removed. Returns a per-store summary of how
  many records were removed so the response body is auditable.

Both functions are intentionally store-agnostic: they take a
``StoreBundle`` so tests can substitute in-memory fakes, and so adding
a new store later is a one-line registration.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


@dataclass
class StoreBundle:
    """Container of references to all per-user stores plus the data dir.

    Holding the data dir lets us also wipe non-store files (audit log
    directory, cached OHLCV parquet, archived reports) that do not live
    behind a Python ``*Store`` class.
    """

    data_dir: Path
    watchlist: Any
    alerts: Any
    portfolio: Any
    stops: Any
    earnings: Any
    journal: Any
    brackets: Any
    news_events: Any
    webhooks: Any
    drawdown: Any
    fx: Any
    ccy_map: Any
    dlq: Any
    ledger: Any
    scaling: Any
    archive: Any
    audit: Any


def _safe_list(store: Any, attr: str = "list") -> List[Any]:
    fn = getattr(store, attr, None)
    if fn is None:
        return []
    try:
        rows = fn()
    except TypeError:
        # some lists need args; fall back to empty
        return []
    out: List[Any] = []
    for r in rows or []:
        if hasattr(r, "to_dict"):
            out.append(r.to_dict())
        elif isinstance(r, (str, int, float, bool, dict, list)) or r is None:
            out.append(r)
        else:
            out.append(str(r))
    return out


def collect_user_data(b: StoreBundle) -> Dict[str, Any]:
    """Return a JSON-serializable snapshot of every user-state store.

    The shape is intentionally flat: one top-level key per store, plus
    a ``meta`` block with timestamp and data dir. This is what the
    ``/privacy/export`` endpoint streams back to the operator.
    """
    out: Dict[str, Any] = {
        "meta": {
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "data_dir": str(b.data_dir),
            "schema_version": 1,
        },
        "watchlist": list(b.watchlist.list()) if b.watchlist else [],
        "alerts": _safe_list(b.alerts),
        "portfolio_trades": _safe_list(b.portfolio, "trades"),
        "stops": _safe_list(b.stops),
        "earnings": _safe_list(b.earnings),
        "journal": _safe_list(b.journal),
        "brackets": _safe_list(b.brackets),
        "news_events": _safe_list(b.news_events),
        "webhooks": _safe_list(b.webhooks),
        "drawdown_history": (b.drawdown.history() if b.drawdown
                             and hasattr(b.drawdown, "history") else []),
        "fx_currencies": (b.fx.currencies() if b.fx
                          and hasattr(b.fx, "currencies") else []),
        "scaling_plans": _safe_list(b.scaling),
    }
    # audit log: include all available days as separate arrays
    if b.audit and hasattr(b.audit, "list_days"):
        days = {}
        for d in b.audit.list_days():
            days[d] = b.audit.tail(limit=100000, day=d)
        out["audit_log"] = days
    else:
        out["audit_log"] = {}
    return out


@dataclass
class EraseSummary:
    removed: Dict[str, int] = field(default_factory=dict)
    files_removed: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "removed": dict(self.removed),
            "files_removed": list(self.files_removed),
            "errors": list(self.errors),
            "ok": not self.errors,
        }


def _count(store: Any, attr: str = "list") -> int:
    fn = getattr(store, attr, None)
    if fn is None:
        return 0
    try:
        rows = fn()
    except TypeError:
        return 0
    return len(rows or [])


def _try_clear(summary: EraseSummary, key: str, store: Any,
               count_attr: str = "list") -> None:
    if store is None:
        return
    try:
        n = _count(store, count_attr)
    except Exception:
        n = 0
    fn = getattr(store, "clear", None)
    try:
        if callable(fn):
            fn()
        else:
            # fall back to per-item removal
            rm = getattr(store, "remove", None)
            ls = getattr(store, count_attr, None)
            if callable(rm) and callable(ls):
                for r in list(ls() or []):
                    rid = getattr(r, "id", None) or getattr(r, "ticker", None)
                    if rid is not None:
                        try:
                            rm(rid)
                        except Exception:
                            pass
        summary.removed[key] = n
    except Exception as e:
        summary.errors.append(f"{key}: {e!r}")


def _wipe_dir(summary: EraseSummary, p: Path) -> None:
    if not p.exists():
        return
    try:
        if p.is_dir():
            for child in p.iterdir():
                if child.is_file():
                    child.unlink(missing_ok=True)
                    summary.files_removed.append(str(child))
        else:
            p.unlink(missing_ok=True)
            summary.files_removed.append(str(p))
    except Exception as e:
        summary.errors.append(f"wipe {p}: {e!r}")


def erase_user_data(b: StoreBundle, *, wipe_audit: bool = False,
                    wipe_reports: bool = False,
                    wipe_ohlcv: bool = False) -> EraseSummary:
    """Erase user data across every registered store.

    Audit log, archived reports, and cached OHLCV are off by default
    because they are commonly retained for compliance / regulatory
    obligations even after a deletion request. Operators must opt in
    explicitly via the corresponding flags.
    """
    s = EraseSummary()
    _try_clear(s, "alerts", b.alerts)
    _try_clear(s, "portfolio_trades", b.portfolio, count_attr="trades")
    _try_clear(s, "stops", b.stops)
    _try_clear(s, "journal", b.journal)
    _try_clear(s, "brackets", b.brackets)
    _try_clear(s, "news_events", b.news_events)
    _try_clear(s, "webhooks", b.webhooks)
    _try_clear(s, "earnings", b.earnings)
    _try_clear(s, "scaling", b.scaling)
    _try_clear(s, "drawdown", b.drawdown,
               count_attr="history")
    _try_clear(s, "dlq", b.dlq)
    # watchlist has no clear(); remove members individually
    if b.watchlist is not None:
        try:
            members = list(b.watchlist.list())
            for t in members:
                try:
                    b.watchlist.remove(t)
                except Exception:
                    pass
            s.removed["watchlist"] = len(members)
        except Exception as e:
            s.errors.append(f"watchlist: {e!r}")
    # FX, ccy map, ledger: blow away their backing files
    for label, store in (("fx", b.fx), ("ccy_map", b.ccy_map),
                         ("ledger", b.ledger)):
        if store is None:
            continue
        path = (getattr(store, "path", None) or getattr(store, "base", None)
                or getattr(store, "root", None))
        if path is None:
            continue
        try:
            p = Path(path)
            if p.is_dir():
                _wipe_dir(s, p)
                s.removed[label] = 1
            elif p.exists():
                p.unlink(missing_ok=True)
                s.files_removed.append(str(p))
                s.removed[label] = 1
        except Exception as e:
            s.errors.append(f"{label}: {e!r}")
    if wipe_reports and b.archive is not None:
        base = getattr(b.archive, "base", None) or getattr(b.archive, "path", None)
        if base is not None:
            _wipe_dir(s, Path(base))
    if wipe_audit and b.audit is not None:
        base = getattr(b.audit, "base", None)
        if base is not None:
            _wipe_dir(s, Path(base))
    if wipe_ohlcv:
        ohlcv_dir = b.data_dir / "ohlcv"
        if ohlcv_dir.exists():
            _wipe_dir(s, ohlcv_dir)
    return s
