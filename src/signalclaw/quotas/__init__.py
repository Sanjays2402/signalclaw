"""Monthly request quotas per API key, organised by billing plan.

Enterprise procurement reviews routinely ask: "How do you cap usage
per customer, and how do we see what they consumed this month for
billing?" This module is the answer.

Design
------

* Plans are a small static catalogue: ``free``, ``pro``, ``enterprise``.
  Each plan carries a monthly request ceiling and a per-minute burst
  cap. Operators can extend the catalogue without code changes via
  ``SIGNALCLAW_PLANS_JSON`` (see :func:`load_plans_from_env`).
* Usage is tracked per (key_id, YYYY-MM) in a JSON file under
  ``<data_dir>/quotas.json``. Bumping the counter is O(1) and the
  whole file is rewritten atomically on each flush; volume is bounded
  by ``keys * months_retained`` so a noisy customer cannot grow it
  without bound.
* Plan assignment is per API key. ``QuotaStore.plan_for(key_id)``
  returns the assigned plan or the default (``free``) so requests
  authenticated by a freshly-minted key still get a sane ceiling.
* When a key exceeds its monthly ceiling we return HTTP 429 with
  standard ``X-RateLimit-Limit``/``Remaining``/``Reset`` headers and
  a ``Retry-After`` set to the seconds until the start of the next
  calendar month (UTC). Success responses receive the same headers so
  a customer dashboard can render "you have used 412 of 10,000 calls
  this month" without a separate probe.

The middleware sits OUTSIDE auth (so we know the key id) and INSIDE
the per-minute rate limiter, so a burst gets shaped first and only
the surviving requests count against the monthly quota.
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Mapping, Optional, Tuple


__all__ = [
    "Plan",
    "DEFAULT_PLANS",
    "load_plans_from_env",
    "QuotaStore",
    "get_quota_store",
    "reset_quota_store",
    "month_key",
    "seconds_until_next_month",
]


@dataclass(frozen=True)
class Plan:
    """A billing plan. ``monthly_limit`` <= 0 means unlimited."""
    id: str
    label: str
    monthly_limit: int
    rate_per_minute: int

    def to_public(self) -> Dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "monthly_limit": int(self.monthly_limit),
            "rate_per_minute": int(self.rate_per_minute),
            "unlimited": self.monthly_limit <= 0,
        }


# Conservative defaults. Operators override via SIGNALCLAW_PLANS_JSON.
DEFAULT_PLANS: Tuple[Plan, ...] = (
    Plan(id="free", label="Free", monthly_limit=10_000, rate_per_minute=60),
    Plan(id="pro", label="Pro", monthly_limit=250_000, rate_per_minute=300),
    Plan(id="enterprise", label="Enterprise",
         monthly_limit=0, rate_per_minute=1_200),
)

DEFAULT_PLAN_ID = "free"


def load_plans_from_env() -> Tuple[Plan, ...]:
    """Return the active plan catalogue.

    Reads ``SIGNALCLAW_PLANS_JSON`` if set; otherwise returns the
    built-in defaults. Malformed JSON or missing fields fall back to
    defaults so a typo in production env does not brick auth.
    """
    raw = os.environ.get("SIGNALCLAW_PLANS_JSON", "").strip()
    if not raw:
        return DEFAULT_PLANS
    try:
        data = json.loads(raw)
        if not isinstance(data, list) or not data:
            return DEFAULT_PLANS
        out = []
        for it in data:
            if not isinstance(it, dict) or "id" not in it:
                continue
            out.append(Plan(
                id=str(it["id"]),
                label=str(it.get("label", it["id"])),
                monthly_limit=int(it.get("monthly_limit", 0) or 0),
                rate_per_minute=int(it.get("rate_per_minute", 60) or 60),
            ))
        return tuple(out) or DEFAULT_PLANS
    except Exception:
        return DEFAULT_PLANS


def month_key(now: Optional[datetime] = None) -> str:
    """Return the current billing month bucket, e.g. ``"2026-05"``."""
    now = now or datetime.now(timezone.utc)
    return f"{now.year:04d}-{now.month:02d}"


def seconds_until_next_month(now: Optional[datetime] = None) -> int:
    """Seconds until 00:00:00 UTC on the first of the next month."""
    now = now or datetime.now(timezone.utc)
    if now.month == 12:
        nxt = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        nxt = datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)
    return max(1, int((nxt - now).total_seconds()))


class QuotaStore:
    """JSON-backed monthly usage counters keyed by (key_id, month).

    Schema on disk::

        {
            "plans": {"<key_id>": "<plan_id>"},
            "usage": {"<key_id>": {"<YYYY-MM>": <int>}}
        }
    """

    def __init__(self, path: Path, plans: Iterable[Plan] = DEFAULT_PLANS,
                 default_plan_id: str = DEFAULT_PLAN_ID) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._plans: Dict[str, Plan] = {p.id: p for p in plans}
        if default_plan_id not in self._plans:
            # Fall back to the first plan if the configured default was
            # removed from the catalogue.
            default_plan_id = next(iter(self._plans))
        self._default_plan_id = default_plan_id
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps(
                {"plans": {}, "usage": {}}, indent=2))
        self._data = self._load()

    # ---- persistence -----------------------------------------------
    def _load(self) -> Dict[str, Dict]:
        try:
            d = json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError:
            d = {}
        d.setdefault("plans", {})
        d.setdefault("usage", {})
        return d

    def _flush(self) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp.replace(self.path)

    # ---- plan catalogue -------------------------------------------
    def plans(self) -> Tuple[Plan, ...]:
        return tuple(self._plans.values())

    def default_plan_id(self) -> str:
        return self._default_plan_id

    def plan(self, plan_id: str) -> Plan:
        return self._plans.get(plan_id, self._plans[self._default_plan_id])

    def plan_for(self, key_id: Optional[str]) -> Plan:
        if not key_id:
            return self.plan(self._default_plan_id)
        with self._lock:
            pid = self._data["plans"].get(key_id, self._default_plan_id)
        return self.plan(pid)

    def set_plan(self, key_id: str, plan_id: str) -> Plan:
        """Assign a plan to a key. Returns the resolved plan."""
        if plan_id not in self._plans:
            raise ValueError(
                f"unknown plan {plan_id!r}; must be one of {sorted(self._plans)}")
        with self._lock:
            self._data["plans"][key_id] = plan_id
            self._flush()
        return self._plans[plan_id]

    # ---- usage ----------------------------------------------------
    def usage(self, key_id: str, month: Optional[str] = None) -> int:
        m = month or month_key()
        with self._lock:
            return int(self._data["usage"].get(key_id, {}).get(m, 0))

    def usage_all(self) -> Dict[str, Dict[str, int]]:
        with self._lock:
            # Deep copy via json round-trip so callers cannot mutate
            # our internal state by holding the returned dict.
            return json.loads(json.dumps(self._data["usage"]))

    def increment(self, key_id: str, amount: int = 1,
                  month: Optional[str] = None) -> int:
        """Bump usage and return the new count.

        Does NOT enforce the ceiling: enforcement is the middleware's
        job so that response headers reflect the post-increment state.
        """
        if amount <= 0:
            return self.usage(key_id, month)
        m = month or month_key()
        with self._lock:
            row = self._data["usage"].setdefault(key_id, {})
            row[m] = int(row.get(m, 0)) + int(amount)
            self._flush()
            return int(row[m])

    def remaining(self, key_id: str, month: Optional[str] = None
                  ) -> Tuple[int, Plan]:
        """Return (remaining, plan). ``-1`` for unlimited plans."""
        plan = self.plan_for(key_id)
        if plan.monthly_limit <= 0:
            return -1, plan
        used = self.usage(key_id, month)
        return max(0, plan.monthly_limit - used), plan

    def reset_usage(self, key_id: Optional[str] = None) -> None:
        """Wipe usage for one key, or all keys when ``key_id`` is None."""
        with self._lock:
            if key_id is None:
                self._data["usage"] = {}
            else:
                self._data["usage"].pop(key_id, None)
            self._flush()


_STORE: Optional[QuotaStore] = None
_STORE_LOCK = threading.Lock()


def get_quota_store(path: Optional[Path] = None,
                    plans: Optional[Iterable[Plan]] = None,
                    default_plan_id: str = DEFAULT_PLAN_ID) -> QuotaStore:
    """Return a process-wide singleton, creating it on first call.

    When ``path`` is passed and differs from the current singleton's
    path, rebuilds the store at the new path. This matters in tests
    (and in any deployment that rebuilds the app with a different
    ``DATA_DIR``) so usage does not silently bleed across instances.
    """
    global _STORE
    with _STORE_LOCK:
        if path is not None:
            target = Path(path)
            if _STORE is None or _STORE.path != target:
                _STORE = QuotaStore(
                    target,
                    plans=plans if plans is not None else load_plans_from_env(),
                    default_plan_id=default_plan_id,
                )
        elif _STORE is None:
            # Fallback: derive a path from DATA_DIR so an early caller
            # (for example a test that imports the store before the
            # app factory has run) does not crash. Production callers
            # always pass the path explicitly via create_app.
            base = Path(os.environ.get("DATA_DIR", "data"))
            _STORE = QuotaStore(
                base / "quotas.json",
                plans=plans if plans is not None else load_plans_from_env(),
                default_plan_id=default_plan_id,
            )
    return _STORE


def reset_quota_store() -> None:
    """Test-only: drop the singleton so the next call rebuilds it."""
    global _STORE
    with _STORE_LOCK:
        _STORE = None
