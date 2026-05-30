"""Retry with exponential backoff + jitter for notifier sends.

Captures every attempt to either succeed-and-return, or fall through and
enqueue the message to a dead-letter queue for later replay.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
import json
import random
import threading
import time
import uuid

from .base import Notifier


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    initial_delay: float = 0.5  # seconds
    max_delay: float = 8.0
    backoff: float = 2.0
    jitter: float = 0.25  # 0..1 fraction of computed delay

    def delay_for(self, attempt: int) -> float:
        """Delay before attempt N (1-indexed). attempt=1 -> 0 (immediate)."""
        if attempt <= 1:
            return 0.0
        raw = min(self.max_delay,
                   self.initial_delay * (self.backoff ** (attempt - 2)))
        if self.jitter > 0:
            spread = raw * self.jitter
            raw = max(0.0, raw + random.uniform(-spread, spread))
        return raw

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if self.initial_delay < 0 or self.max_delay < 0:
            raise ValueError("delays must be non-negative")
        if self.backoff < 1:
            raise ValueError("backoff must be >= 1")
        if not 0 <= self.jitter <= 1:
            raise ValueError("jitter must be in [0, 1]")


@dataclass
class DeadLetter:
    id: str
    channel: str
    text: str
    attempts: int
    last_error: str
    enqueued_at: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "channel": self.channel, "text": self.text,
            "attempts": self.attempts, "last_error": self.last_error,
            "enqueued_at": self.enqueued_at,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeadLetter":
        return cls(
            id=str(d.get("id") or uuid.uuid4().hex[:10]),
            channel=str(d["channel"]),
            text=str(d["text"]),
            attempts=int(d.get("attempts", 0)),
            last_error=str(d.get("last_error", "")),
            enqueued_at=str(d.get("enqueued_at") or
                             datetime.now(timezone.utc).isoformat()),
        )


class DeadLetterQueue:
    """JSON-backed queue. Append-only with explicit drain/pop."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"items": []}, indent=2))

    def _read(self) -> List[DeadLetter]:
        raw = json.loads(self.path.read_text() or '{"items":[]}')
        return [DeadLetter.from_dict(x) for x in raw.get("items", [])]

    def _write(self, items: List[DeadLetter]) -> None:
        self.path.write_text(json.dumps(
            {"items": [x.to_dict() for x in items]},
            indent=2, sort_keys=True,
        ))

    def enqueue(self, dl: DeadLetter) -> DeadLetter:
        with self._lock:
            items = self._read()
            items.append(dl)
            self._write(items)
        return dl

    def list(self, channel: Optional[str] = None) -> List[DeadLetter]:
        items = self._read()
        if channel:
            items = [x for x in items if x.channel == channel]
        return items

    def remove(self, dl_id: str) -> bool:
        with self._lock:
            items = self._read()
            new = [x for x in items if x.id != dl_id]
            if len(new) == len(items):
                return False
            self._write(new)
        return True

    def clear(self) -> None:
        with self._lock:
            self._write([])


def send_with_retry(
    notifier: Notifier,
    text: str,
    *,
    channel: str,
    policy: RetryPolicy = RetryPolicy(),
    dlq: Optional[DeadLetterQueue] = None,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Attempt to send `text` with retries. Returns True on success.

    On final failure, enqueues a DeadLetter when `dlq` is provided. The
    notifier.send is treated as failed when it returns False OR raises.
    """
    last_error = ""
    for attempt in range(1, policy.max_attempts + 1):
        delay = policy.delay_for(attempt)
        if delay > 0:
            sleep(delay)
        try:
            ok = bool(notifier.send(text))
        except Exception as e:  # noqa: BLE001
            ok = False
            last_error = f"{type(e).__name__}: {e}"
        else:
            if ok:
                return True
            last_error = last_error or "send returned False"
    if dlq is not None:
        dlq.enqueue(DeadLetter(
            id=uuid.uuid4().hex[:10],
            channel=channel,
            text=text,
            attempts=policy.max_attempts,
            last_error=last_error,
            enqueued_at=datetime.now(timezone.utc).isoformat(),
        ))
    return False


def replay_dlq(
    dlq: DeadLetterQueue,
    notifier_factory: Callable[[str], Optional[Notifier]],
    *,
    policy: RetryPolicy = RetryPolicy(max_attempts=2),
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, int]:
    """Re-send every item in the DLQ via notifier_factory(channel).

    Items that succeed are removed; items that fail again stay enqueued.
    Returns counts: sent, kept, skipped (no notifier available for channel).
    """
    sent = 0
    kept = 0
    skipped = 0
    for item in list(dlq.list()):
        notifier = notifier_factory(item.channel)
        if notifier is None:
            skipped += 1
            continue
        success = send_with_retry(
            notifier, item.text, channel=item.channel,
            policy=policy, dlq=None, sleep=sleep,
        )
        if success:
            dlq.remove(item.id)
            sent += 1
        else:
            kept += 1
    return {"sent": sent, "kept": kept, "skipped": skipped}


__all__ = [
    "RetryPolicy",
    "DeadLetter",
    "DeadLetterQueue",
    "send_with_retry",
    "replay_dlq",
]
