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

import base64
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


# --- delivery log -------------------------------------------------------


@dataclass
class DeliveryAttempt:
    """One outbound HTTP attempt recorded for audit + replay.

    Stores the exact signed payload so a failed delivery can be re-sent
    byte-for-byte without re-deriving the event list (which may have
    changed since).
    """
    id: str
    subscription_id: str
    url: str
    status: Optional[int]
    error: Optional[str]
    attempt: int                       # 1-based; bumped by retry/replay
    delivered_at: str
    signature: Optional[str]           # full "sha256=..." header
    event_count: int
    events: List[Dict[str, Any]] = field(default_factory=list)
    payload_b64: Optional[str] = None  # base64 of the signed body (replay)
    replay_of: Optional[str] = None    # parent attempt id when replayed

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeliveryAttempt":
        return cls(
            id=str(d.get("id") or uuid.uuid4().hex[:12]),
            subscription_id=str(d.get("subscription_id", "")),
            url=str(d.get("url", "")),
            status=d.get("status"),
            error=d.get("error"),
            attempt=int(d.get("attempt", 1)),
            delivered_at=str(d.get("delivered_at",
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))),
            signature=d.get("signature"),
            event_count=int(d.get("event_count", 0)),
            events=list(d.get("events") or []),
            payload_b64=d.get("payload_b64"),
            replay_of=d.get("replay_of"),
        )


class DeliveryLogStore:
    """Append-only ring of webhook delivery attempts.

    Persisted as JSON. The newest ``max_entries`` attempts are kept;
    older ones are pruned on write. Reads return newest-first.
    """

    def __init__(self, path: Path, max_entries: int = 500) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.max_entries = int(max_entries)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"deliveries": []}, indent=2))

    def _read(self) -> List[DeliveryAttempt]:
        try:
            raw = json.loads(self.path.read_text() or '{"deliveries":[]}')
        except json.JSONDecodeError:
            return []
        return [DeliveryAttempt.from_dict(d) for d in raw.get("deliveries", [])]

    def _write(self, rows: List[DeliveryAttempt]) -> None:
        rows = rows[-self.max_entries:]
        self.path.write_text(json.dumps(
            {"deliveries": [r.to_dict() for r in rows]},
            indent=2, sort_keys=True))

    def append(self, attempt: DeliveryAttempt) -> DeliveryAttempt:
        with self._lock:
            rows = self._read()
            rows.append(attempt)
            self._write(rows)
        return attempt

    def list(self, limit: int = 100,
             status: Optional[str] = None,
             subscription_id: Optional[str] = None) -> List[DeliveryAttempt]:
        rows = list(reversed(self._read()))
        if subscription_id:
            rows = [r for r in rows if r.subscription_id == subscription_id]
        if status == "ok":
            rows = [r for r in rows if r.status is not None and 200 <= r.status < 300]
        elif status == "failed":
            rows = [r for r in rows
                    if r.status is None or not (200 <= (r.status or 0) < 300)]
        return rows[: max(1, min(int(limit), self.max_entries))]

    def get(self, attempt_id: str) -> Optional[DeliveryAttempt]:
        for r in self._read():
            if r.id == attempt_id:
                return r
        return None


# --- delivery -----------------------------------------------------------

HttpFn = Callable[[str, bytes, Dict[str, str], int], Tuple[int, str]]


def _next_backoff(attempt: int, base: float = 0.2, cap: float = 5.0) -> float:
    """Exponential backoff seconds for retry ``attempt`` (1-based)."""
    return min(cap, base * (2 ** max(0, attempt - 1)))


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


def _attempt_http(http: HttpFn, url: str, body: bytes,
                  headers: Dict[str, str], timeout: int,
                  max_attempts: int, sleep: Callable[[float], None]) -> Tuple[int, str, int]:
    """Try ``http`` up to ``max_attempts`` times with exponential backoff.

    Retries on connection-level failures (status == 0) and on 5xx/429.
    Returns ``(status, error, attempts)``.
    """
    last_status, last_err = 0, ""
    for attempt in range(1, max(1, int(max_attempts)) + 1):
        last_status, last_err = http(url, body, headers, timeout)
        retryable = last_status == 0 or last_status >= 500 or last_status == 429
        if not retryable or attempt >= max_attempts:
            return last_status, last_err, attempt
        sleep(_next_backoff(attempt))
    return last_status, last_err, max_attempts


def deliver_events(
    events: Iterable[PickEvent],
    store: WebhookStore,
    http: Optional[HttpFn] = None,
    timeout: int = 5,
    log_store: Optional[DeliveryLogStore] = None,
    max_attempts: int = 3,
    sleep: Optional[Callable[[float], None]] = None,
) -> List[Dict[str, Any]]:
    """Send events to every matching subscriber with retries + delivery log.

    Each subscription gets one logical delivery; transient failures
    (network errors, 5xx, 429) are retried with exponential backoff up
    to ``max_attempts``. The final outcome is appended to ``log_store``
    when provided, including the signed payload so the attempt can be
    replayed later byte-for-byte via :func:`replay_delivery`.
    """
    http = http or _default_http
    sleep = sleep or time.sleep
    events = list(events)
    if not events:
        return []
    subs = store.list()
    results: List[Dict[str, Any]] = []
    for sub in subs:
        matched = [e.to_dict() for e in events if sub.matches(e)]
        if not matched:
            continue
        delivered_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload = {"events": matched, "subscription_id": sub.id,
                   "delivered_at": delivered_at}
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        headers = {"content-type": "application/json",
                   "user-agent": "signalclaw-webhook/1"}
        signature = None
        if sub.secret:
            signature = "sha256=" + _sign(sub.secret, body)
            headers["x-signalclaw-signature"] = signature
        status, err, attempts = _attempt_http(
            http, sub.url, body, headers, timeout, max_attempts, sleep)
        sub.last_status = int(status)
        sub.last_error = err or None
        sub.last_delivered_at = delivered_at
        store.update(sub)
        if log_store is not None:
            log_store.append(DeliveryAttempt(
                id=uuid.uuid4().hex[:12],
                subscription_id=sub.id,
                url=sub.url,
                status=int(status) if status else None,
                error=err or None,
                attempt=attempts,
                delivered_at=delivered_at,
                signature=signature,
                event_count=len(matched),
                events=matched,
                payload_b64=base64.b64encode(body).decode("ascii"),
            ))
        results.append({"subscription_id": sub.id, "url": sub.url,
                        "status": status, "n_events": len(matched),
                        "attempts": attempts,
                        "error": err or None})
    return results


def replay_delivery(
    attempt_id: str,
    sub_store: WebhookStore,
    log_store: DeliveryLogStore,
    http: Optional[HttpFn] = None,
    timeout: int = 5,
    max_attempts: int = 3,
    sleep: Optional[Callable[[float], None]] = None,
) -> Optional[DeliveryAttempt]:
    """Re-send a previously logged attempt byte-for-byte.

    Returns the new :class:`DeliveryAttempt` (linked via ``replay_of``)
    or ``None`` if the original attempt or its subscription is gone.
    The signed payload is reused verbatim so HMAC stays valid.
    """
    original = log_store.get(attempt_id)
    if original is None or not original.payload_b64:
        return None
    sub = next((s for s in sub_store.list() if s.id == original.subscription_id), None)
    if sub is None:
        return None
    http = http or _default_http
    sleep = sleep or time.sleep
    body = base64.b64decode(original.payload_b64)
    headers = {"content-type": "application/json",
               "user-agent": "signalclaw-webhook/1"}
    if original.signature:
        headers["x-signalclaw-signature"] = original.signature
    status, err, attempts = _attempt_http(
        http, sub.url, body, headers, timeout, max_attempts, sleep)
    delivered_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sub.last_status = int(status)
    sub.last_error = err or None
    sub.last_delivered_at = delivered_at
    sub_store.update(sub)
    return log_store.append(DeliveryAttempt(
        id=uuid.uuid4().hex[:12],
        subscription_id=sub.id,
        url=sub.url,
        status=int(status) if status else None,
        error=err or None,
        attempt=attempts,
        delivered_at=delivered_at,
        signature=original.signature,
        event_count=original.event_count,
        events=list(original.events),
        payload_b64=original.payload_b64,
        replay_of=original.id,
    ))
