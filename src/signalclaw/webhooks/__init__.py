"""Pick-change webhook subscriptions and event delivery.

Fits between the daily ranking engine and external systems (Slack,
Discord, generic HTTP). Two pieces:

* ``diff_picks`` compares today's picks vs a prior snapshot and emits
  structured ``PickEvent``s (entered, exited, upgraded, downgraded,
  score_jump).
* ``WebhookStore`` persists subscriber URLs with event filters and an
  optional HMAC secret. ``deliver_events`` POSTs the event payload to
  each matching subscriber and records last success / failure on the
  subscription record for visibility.

The deliverer accepts an injectable HTTP function so tests run offline.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


EVENT_KINDS = {"entered", "exited", "upgraded", "downgraded", "score_jump"}


@dataclass
class PickEvent:
    kind: str               # one of EVENT_KINDS
    ticker: str
    as_of: str
    prior_as_of: Optional[str] = None
    prior_label: Optional[str] = None
    new_label: Optional[str] = None
    prior_score: Optional[float] = None
    new_score: Optional[float] = None
    score_delta: Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)


def _label_rank(lbl: Optional[str]) -> int:
    return {"skip": 0, "hold": 1, "watch": 2}.get((lbl or "").lower(), -1)


def diff_picks(
    current: List[Dict[str, Any]],
    prior: Optional[List[Dict[str, Any]]],
    current_as_of: str,
    prior_as_of: Optional[str] = None,
    score_jump_threshold: float = 0.15,
) -> List[PickEvent]:
    """Return events describing how today's picks moved vs a prior list.

    ``current`` and ``prior`` are lists of dicts with at least
    ``ticker``, ``label``, and ``score`` keys (matching ``DailyPick.to_dict``).
    """
    cur_by_ticker = {p["ticker"].upper(): p for p in current}
    prior_by_ticker = {p["ticker"].upper(): p for p in (prior or [])}
    events: List[PickEvent] = []

    for t, c in cur_by_ticker.items():
        if t not in prior_by_ticker:
            events.append(PickEvent(
                kind="entered", ticker=t, as_of=current_as_of,
                prior_as_of=prior_as_of, new_label=c.get("label"),
                new_score=float(c.get("score", 0.0)),
            ))
            continue
        p = prior_by_ticker[t]
        c_rank = _label_rank(c.get("label"))
        p_rank = _label_rank(p.get("label"))
        if c_rank > p_rank:
            events.append(PickEvent(
                kind="upgraded", ticker=t, as_of=current_as_of,
                prior_as_of=prior_as_of, prior_label=p.get("label"),
                new_label=c.get("label"),
                prior_score=float(p.get("score", 0.0)),
                new_score=float(c.get("score", 0.0)),
                score_delta=float(c.get("score", 0.0)) - float(p.get("score", 0.0)),
            ))
        elif c_rank < p_rank:
            events.append(PickEvent(
                kind="downgraded", ticker=t, as_of=current_as_of,
                prior_as_of=prior_as_of, prior_label=p.get("label"),
                new_label=c.get("label"),
                prior_score=float(p.get("score", 0.0)),
                new_score=float(c.get("score", 0.0)),
                score_delta=float(c.get("score", 0.0)) - float(p.get("score", 0.0)),
            ))
        else:
            delta = float(c.get("score", 0.0)) - float(p.get("score", 0.0))
            if abs(delta) >= score_jump_threshold:
                events.append(PickEvent(
                    kind="score_jump", ticker=t, as_of=current_as_of,
                    prior_as_of=prior_as_of, prior_label=p.get("label"),
                    new_label=c.get("label"),
                    prior_score=float(p.get("score", 0.0)),
                    new_score=float(c.get("score", 0.0)),
                    score_delta=delta,
                ))

    for t, p in prior_by_ticker.items():
        if t not in cur_by_ticker:
            events.append(PickEvent(
                kind="exited", ticker=t, as_of=current_as_of,
                prior_as_of=prior_as_of, prior_label=p.get("label"),
                prior_score=float(p.get("score", 0.0)),
            ))
    return events


# --- subscriptions ------------------------------------------------------

@dataclass
class WebhookSubscription:
    url: str
    events: List[str] = field(default_factory=lambda: sorted(EVENT_KINDS))
    tickers: List[str] = field(default_factory=list)    # empty == all
    secret: str = ""                                    # HMAC SHA256 key
    enabled: bool = True
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created_at: str = field(default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    last_status: Optional[int] = None
    last_error: Optional[str] = None
    last_delivered_at: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "WebhookSubscription":
        return cls(
            id=d.get("id", uuid.uuid4().hex[:10]),
            url=str(d["url"]),
            events=list(d.get("events", sorted(EVENT_KINDS))),
            tickers=[t.upper() for t in d.get("tickers", [])],
            secret=str(d.get("secret", "")),
            enabled=bool(d.get("enabled", True)),
            created_at=str(d.get("created_at",
                                  time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))),
            last_status=d.get("last_status"),
            last_error=d.get("last_error"),
            last_delivered_at=d.get("last_delivered_at"),
        )

    def matches(self, ev: PickEvent) -> bool:
        if not self.enabled:
            return False
        if self.events and ev.kind not in self.events:
            return False
        if self.tickers and ev.ticker.upper() not in self.tickers:
            return False
        return True


class WebhookStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"subs": []}, indent=2))

    def _read(self) -> List[WebhookSubscription]:
        raw = json.loads(self.path.read_text() or '{"subs":[]}')
        return [WebhookSubscription.from_dict(s) for s in raw.get("subs", [])]

    def _write(self, subs: List[WebhookSubscription]) -> None:
        self.path.write_text(json.dumps(
            {"subs": [s.to_dict() for s in subs]}, indent=2, sort_keys=True))

    def list(self) -> List[WebhookSubscription]:
        return self._read()

    def add(self, sub: WebhookSubscription) -> WebhookSubscription:
        with self._lock:
            rows = self._read()
            rows.append(sub)
            self._write(rows)
        return sub

    def remove(self, sub_id: str) -> bool:
        with self._lock:
            rows = self._read()
            new = [s for s in rows if s.id != sub_id]
            if len(new) == len(rows):
                return False
            self._write(new)
        return True

    def update(self, sub: WebhookSubscription) -> None:
        with self._lock:
            rows = self._read()
            rows = [sub if s.id == sub.id else s for s in rows]
            self._write(rows)


# --- delivery -----------------------------------------------------------

HttpFn = Callable[[str, bytes, Dict[str, str], int], Tuple[int, str]]


def _default_http(url: str, body: bytes, headers: Dict[str, str],
                  timeout: int = 5) -> Tuple[int, str]:
    req = urllib.request.Request(url, data=body, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, ""
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, str(e)


def _sign(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def deliver_events(
    events: Iterable[PickEvent],
    store: WebhookStore,
    http: Optional[HttpFn] = None,
    timeout: int = 5,
) -> List[Dict[str, Any]]:
    """Send events to every matching subscriber. Returns per-attempt results."""
    http = http or _default_http
    events = list(events)
    if not events:
        return []
    subs = store.list()
    results: List[Dict[str, Any]] = []
    for sub in subs:
        matched = [e.to_dict() for e in events if sub.matches(e)]
        if not matched:
            continue
        payload = {"events": matched, "subscription_id": sub.id,
                   "delivered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        headers = {"content-type": "application/json",
                   "user-agent": "signalclaw-webhook/1"}
        if sub.secret:
            headers["x-signalclaw-signature"] = "sha256=" + _sign(sub.secret, body)
        status, err = http(sub.url, body, headers, timeout)
        sub.last_status = int(status)
        sub.last_error = err or None
        sub.last_delivered_at = payload["delivered_at"]
        store.update(sub)
        results.append({"subscription_id": sub.id, "url": sub.url,
                        "status": status, "n_events": len(matched),
                        "error": err or None})
    return results
