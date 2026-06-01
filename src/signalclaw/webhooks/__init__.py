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

from .destination import (
    DestinationPolicy,
    assert_destination_safe,
    validate_destination,
    validate_destination_or_raise,
)


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

# Sentinel marking a webhook that was created before per-key ownership
# was added, or by the operator-default admin key. ``None``-owned rows
# are visible only to admins and to the legacy default-key caller, so
# legacy data does not silently leak to a newly-created user key.
LEGACY_OWNER: Optional[str] = None

# Circuit breaker: number of consecutive failed logical deliveries
# (after per-delivery retries) before a subscription is auto-disabled.
# Stripe uses ~16, GitHub uses 3. We pick 5 for a self-hosted low-volume
# signal stream so dead endpoints stop being hammered.
AUTO_DISABLE_FAILURE_THRESHOLD: int = 5


def _is_success(status: Optional[int]) -> bool:
    return status is not None and 200 <= int(status) < 300


OutcomeFn = Callable[["WebhookSubscription", str, Dict[str, Any]], None]


def _apply_outcome(sub: "WebhookSubscription", status: Optional[int],
                   err: Optional[str], now_iso: str) -> Optional[str]:
    """Update circuit-breaker state in-place on ``sub``.

    Returns ``"auto_disabled"`` when this call flipped the subscription
    to auto-disabled, ``"recovered"`` when it cleared a prior
    auto-disable, otherwise ``None``.
    """
    if _is_success(status):
        recovered = sub.auto_disabled_at is not None
        sub.consecutive_failures = 0
        if recovered:
            sub.auto_disabled_at = None
            sub.auto_disable_reason = None
        return "recovered" if recovered else None
    sub.consecutive_failures = int(sub.consecutive_failures or 0) + 1
    if (sub.enabled and sub.auto_disabled_at is None
            and sub.consecutive_failures >= AUTO_DISABLE_FAILURE_THRESHOLD):
        sub.enabled = False
        sub.auto_disabled_at = now_iso
        reason = err or (f"http_{status}" if status else "transport_error")
        sub.auto_disable_reason = str(reason)[:200]
        return "auto_disabled"
    return None


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
    # Webhook signing secret rotation. When an operator rotates the
    # signing secret we keep the prior secret for a grace window so
    # downstream receivers can roll their verifier without missing
    # deliveries. During the grace window we sign with the current
    # secret AND emit an ``X-SignalClaw-Signature-Previous`` header
    # signed by the prior secret. Receivers MUST accept either
    # signature during rotation; once the grace expires only the
    # current secret signs. ISO-8601 UTC, ``Z`` suffix.
    previous_secret: str = ""
    previous_secret_expires_at: Optional[str] = None
    secret_rotated_at: Optional[str] = None
    # Circuit-breaker state. ``consecutive_failures`` counts back-to-back
    # non-2xx logical deliveries (after the per-delivery retry budget
    # is exhausted). When it reaches :data:`AUTO_DISABLE_FAILURE_THRESHOLD`
    # the subscription is flipped to ``enabled=False`` and the
    # ``auto_disabled_at`` / ``auto_disable_reason`` fields are
    # populated. An operator must reactivate via
    # ``POST /webhooks/{id}/reactivate`` once the receiver is healthy.
    # A 2xx delivery resets the counter and clears the auto-disable
    # fields. Required for enterprise procurement so a dead endpoint
    # cannot be hammered or hold a queue indefinitely.
    consecutive_failures: int = 0
    auto_disabled_at: Optional[str] = None
    auto_disable_reason: Optional[str] = None
    # Tenant-isolation field. Holds the ``StoredKey.id`` of the API key
    # that created the subscription. ``None`` is the legacy / admin
    # bucket: rows that predate this field, or that were created by the
    # operator-default ``api_key`` setting, do not belong to any user
    # key. Visibility/mutation gates in the API enforce that callers
    # only see their own rows (admins see all).
    owner_key_id: Optional[str] = None

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
            previous_secret=str(d.get("previous_secret", "") or ""),
            previous_secret_expires_at=d.get("previous_secret_expires_at"),
            secret_rotated_at=d.get("secret_rotated_at"),
            consecutive_failures=int(d.get("consecutive_failures", 0) or 0),
            auto_disabled_at=d.get("auto_disabled_at"),
            auto_disable_reason=d.get("auto_disable_reason"),
            owner_key_id=d.get("owner_key_id"),
        )

    def previous_secret_active(self, now: Optional[float] = None) -> bool:
        """True when the grace-window previous secret should still sign."""
        if not self.previous_secret or not self.previous_secret_expires_at:
            return False
        try:
            exp = time.strptime(self.previous_secret_expires_at,
                                "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            return False
        cur = now if now is not None else time.time()
        return cur < time.mktime(exp) - time.timezone

    def expire_previous_secret_if_due(self,
                                      now: Optional[float] = None) -> bool:
        """Clear the prior secret in-place when the grace has elapsed.

        Returns True iff the record was mutated. Callers are expected
        to persist via :meth:`WebhookStore.update`.
        """
        if not self.previous_secret:
            return False
        if self.previous_secret_active(now=now):
            return False
        self.previous_secret = ""
        self.previous_secret_expires_at = None
        return True

    def is_visible_to(self, owner_key_id: Optional[str],
                      is_admin: bool = False) -> bool:
        """Return True iff a caller with ``owner_key_id`` may see this row.

        Admins see everything. User keys see only rows they own. The
        legacy/admin bucket (``self.owner_key_id is None``) is visible
        only to admins so a brand-new user key cannot inherit data
        created by the operator.
        """
        if is_admin:
            return True
        if self.owner_key_id is None:
            return False
        return self.owner_key_id == owner_key_id

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

    def list_for(self, owner_key_id: Optional[str],
                 is_admin: bool = False) -> List[WebhookSubscription]:
        """Return only the subscriptions a caller is allowed to see."""
        return [s for s in self._read()
                if s.is_visible_to(owner_key_id, is_admin=is_admin)]

    def get(self, sub_id: str) -> Optional[WebhookSubscription]:
        for s in self._read():
            if s.id == sub_id:
                return s
        return None

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
    signature: Optional[str]           # full "sha256=..." header (legacy v1)
    event_count: int
    events: List[Dict[str, Any]] = field(default_factory=list)
    payload_b64: Optional[str] = None  # base64 of the signed body (replay)
    replay_of: Optional[str] = None    # parent attempt id when replayed
    # v2 timestamped signature, Stripe-style. Receivers verify by recomputing
    # HMAC_SHA256(secret, f"{timestamp}.{body}") and rejecting timestamps
    # outside their replay window. Both v1 and v2 are sent for as long as
    # we ship backwards compat; new integrations should pin v2.
    signature_v2: Optional[str] = None  # "v1=<hex>" over timestamp.body
    timestamp: Optional[str] = None      # unix seconds, string

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
            signature_v2=d.get("signature_v2"),
            timestamp=d.get("timestamp"),
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
    # SSRF gate: re-validate the destination on every attempt so a
    # hostname that flips to internal address space after the
    # subscription was created is still refused, including on replay.
    try:
        assert_destination_safe(url)
    except ValueError as e:
        return 0, f"destination_blocked: {e}"
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


def _sign_v2(secret: str, timestamp: str, body: bytes) -> str:
    """Stripe-style timestamped signature: HMAC over ``f"{ts}.{body}"``.

    The timestamp travels in a sibling header so receivers can enforce a
    replay window: a request whose timestamp is older than the window is
    rejected even if the signature itself verifies, defeating capture +
    replay against an idempotent endpoint.
    """
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update(timestamp.encode("ascii"))
    mac.update(b".")
    mac.update(body)
    return "v1=" + mac.hexdigest()


def verify_signature(
    secret: str,
    body: bytes,
    timestamp_header: Optional[str],
    signature_header: Optional[str],
    *,
    tolerance_s: int = 300,
    now: Optional[float] = None,
) -> Tuple[bool, str]:
    """Verify a v2 timestamped webhook signature.

    Returns ``(ok, reason)``. ``reason`` is a short machine string
    (``"ok"``, ``"missing_headers"``, ``"bad_timestamp"``,
    ``"stale"``, ``"bad_format"``, ``"bad_signature"``) suitable for
    logging on the receiver side. ``tolerance_s`` defaults to 5 minutes
    which matches Stripe's published default and is the value most
    procurement reviews expect to see.

    This is the canonical receiver-side helper. It is intentionally
    framework-free so customer integrations can import it directly.
    """
    if not (secret and body is not None and timestamp_header and signature_header):
        return False, "missing_headers"
    try:
        ts_int = int(str(timestamp_header).strip())
    except (TypeError, ValueError):
        return False, "bad_timestamp"
    current = time.time() if now is None else now
    if abs(current - ts_int) > max(1, int(tolerance_s)):
        return False, "stale"
    sig = str(signature_header).strip()
    if not sig.startswith("v1=") or len(sig) < 4:
        return False, "bad_format"
    expected = _sign_v2(secret, str(ts_int), body)
    if not hmac.compare_digest(expected, sig):
        return False, "bad_signature"
    return True, "ok"


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
    on_outcome: Optional[OutcomeFn] = None,
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
        signature_v2 = None
        ts = str(int(time.time()))
        headers["x-signalclaw-timestamp"] = ts
        if sub.expire_previous_secret_if_due():
            store.update(sub)
        if sub.secret:
            signature = "sha256=" + _sign(sub.secret, body)
            headers["x-signalclaw-signature"] = signature
            signature_v2 = _sign_v2(sub.secret, ts, body)
            headers["x-signalclaw-signature-v2"] = signature_v2
        if sub.previous_secret and sub.previous_secret_active():
            headers["x-signalclaw-signature-previous"] = (
                "sha256=" + _sign(sub.previous_secret, body))
            headers["x-signalclaw-signature-v2-previous"] = (
                _sign_v2(sub.previous_secret, ts, body))
        status, err, attempts = _attempt_http(
            http, sub.url, body, headers, timeout, max_attempts, sleep)
        sub.last_status = int(status)
        sub.last_error = err or None
        sub.last_delivered_at = delivered_at
        transition = _apply_outcome(sub, int(status) if status else None,
                                    err or None, delivered_at)
        store.update(sub)
        if on_outcome and transition:
            try:
                on_outcome(sub, transition,
                           {"status": int(status) if status else None,
                            "error": err or None,
                            "consecutive_failures": sub.consecutive_failures,
                            "delivered_at": delivered_at})
            except Exception:
                pass
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
                signature_v2=signature_v2,
                timestamp=ts,
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
    on_outcome: Optional[OutcomeFn] = None,
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
    if original.timestamp:
        # Reuse the original timestamp so the v2 signature (which binds
        # the timestamp into the MAC) still verifies on the receiver.
        # Replays may therefore be rejected by a strict receiver whose
        # tolerance window has passed; that is the desired behaviour.
        headers["x-signalclaw-timestamp"] = original.timestamp
    if original.signature_v2:
        headers["x-signalclaw-signature-v2"] = original.signature_v2
    status, err, attempts = _attempt_http(
        http, sub.url, body, headers, timeout, max_attempts, sleep)
    delivered_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    sub.last_status = int(status)
    sub.last_error = err or None
    sub.last_delivered_at = delivered_at
    transition = _apply_outcome(sub, int(status) if status else None,
                                err or None, delivered_at)
    sub_store.update(sub)
    if on_outcome and transition:
        try:
            on_outcome(sub, transition,
                       {"status": int(status) if status else None,
                        "error": err or None,
                        "consecutive_failures": sub.consecutive_failures,
                        "delivered_at": delivered_at,
                        "replay_of": attempt_id})
        except Exception:
            pass
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
        signature_v2=original.signature_v2,
        timestamp=original.timestamp,
    ))
