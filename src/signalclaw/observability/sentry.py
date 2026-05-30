"""Sentry error tracking integration.

Behaviour:

* If ``SENTRY_DSN`` is unset or empty, every entry point in this
  module is a safe no-op. This is the default for local dev and CI
  so unit tests never need network access or a real DSN.
* When a DSN is configured, :func:`init_sentry` installs the Sentry
  SDK with the FastAPI + Starlette integrations and a configurable
  traces sample rate. PII is off by default; the SDK is told to send
  only request metadata, never bodies or headers it deems sensitive.
* The module degrades gracefully when ``sentry-sdk`` is not installed
  at all (for example minimal CI images). In that case
  :func:`init_sentry` returns ``False`` and logs a single warning,
  rather than raising and taking the whole API process down.

This keeps the wiring small and dependency-light: import-time cost is
zero when Sentry is off, and the public surface (``init_sentry``,
``is_enabled``, ``capture_exception``, ``capture_message``) mirrors
what callers actually need from an error-tracking layer.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

_log = logging.getLogger("signalclaw.observability.sentry")

# Module-level flag flipped by ``init_sentry`` on success. Read by
# ``is_enabled`` and the capture helpers so callers do not have to
# guard their own call sites.
_ENABLED: bool = False


@dataclass(frozen=True)
class SentryConfig:
    """Resolved Sentry settings.

    Built from environment variables so it lines up with how the rest
    of SignalClaw config is wired (pydantic-settings reads the same
    env). Kept as a plain dataclass to avoid a circular import with
    ``signalclaw.config``.
    """

    dsn: str
    environment: str = "development"
    release: Optional[str] = None
    traces_sample_rate: float = 0.0
    profiles_sample_rate: float = 0.0
    send_default_pii: bool = False
    server_name: Optional[str] = None

    @classmethod
    def from_env(cls, env: Optional[dict[str, str]] = None) -> "SentryConfig":
        e = env if env is not None else os.environ
        return cls(
            dsn=e.get("SENTRY_DSN", "").strip(),
            environment=e.get("SENTRY_ENVIRONMENT", "development").strip() or "development",
            release=(e.get("SENTRY_RELEASE") or None),
            traces_sample_rate=_safe_float(e.get("SENTRY_TRACES_SAMPLE_RATE"), 0.0),
            profiles_sample_rate=_safe_float(e.get("SENTRY_PROFILES_SAMPLE_RATE"), 0.0),
            send_default_pii=_safe_bool(e.get("SENTRY_SEND_DEFAULT_PII"), False),
            server_name=(e.get("SENTRY_SERVER_NAME") or None),
        )


def _safe_float(raw: Optional[str], default: float) -> float:
    if raw is None or raw == "":
        return default
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return default
    # Clamp to the valid Sentry range. Out-of-band values silently
    # become 0/1 instead of raising, so a typo in env config cannot
    # crash startup.
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _safe_bool(raw: Optional[str], default: bool) -> bool:
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Drop fields that could contain secrets before send.

    We strip the ``Authorization``, ``Cookie``, and ``X-Api-Key``
    headers, and remove any request body the SDK may have captured.
    This is in addition to ``send_default_pii=False``.
    """
    try:
        req = event.get("request") or {}
        headers = req.get("headers") or {}
        if isinstance(headers, dict):
            for k in list(headers.keys()):
                if k.lower() in {"authorization", "cookie", "x-api-key"}:
                    headers[k] = "[redacted]"
        # Never ship request bodies.
        for key in ("data", "json", "body"):
            if key in req:
                req[key] = "[redacted]"
        event["request"] = req
    except Exception:  # pragma: no cover - defensive, never break send
        pass
    return event


def init_sentry(cfg: Optional[SentryConfig] = None) -> bool:
    """Initialise Sentry. Returns ``True`` iff the SDK was started.

    Safe to call more than once; subsequent calls with a DSN configured
    are no-ops because Sentry's own ``init`` is idempotent per-process.
    """
    global _ENABLED
    config = cfg or SentryConfig.from_env()
    if not config.dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
    except Exception as exc:  # pragma: no cover - dep missing in slim envs
        _log.warning("sentry-sdk not importable, skipping init: %s", exc)
        return False

    integrations = [
        FastApiIntegration(transaction_style="endpoint"),
        StarletteIntegration(transaction_style="endpoint"),
        # Send WARNING+ as breadcrumbs, ERROR+ as events. Keeps the
        # noise floor low without losing real failures.
        LoggingIntegration(level=logging.WARNING, event_level=logging.ERROR),
    ]
    sentry_sdk.init(
        dsn=config.dsn,
        environment=config.environment,
        release=config.release,
        traces_sample_rate=config.traces_sample_rate,
        profiles_sample_rate=config.profiles_sample_rate,
        send_default_pii=config.send_default_pii,
        server_name=config.server_name,
        integrations=integrations,
        before_send=_scrub_event,
    )
    _ENABLED = True
    _log.info(
        "sentry.initialised env=%s traces=%.3f profiles=%.3f",
        config.environment, config.traces_sample_rate, config.profiles_sample_rate,
    )
    return True


def is_enabled() -> bool:
    """Whether ``init_sentry`` successfully started the SDK."""
    return _ENABLED


def capture_exception(exc: BaseException) -> None:
    """Forward an exception to Sentry if enabled, else no-op."""
    if not _ENABLED:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_exception(exc)
    except Exception:  # pragma: no cover
        _log.exception("sentry.capture_exception failed")


def capture_message(msg: str, level: str = "info") -> None:
    """Forward a message to Sentry if enabled, else no-op."""
    if not _ENABLED:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_message(msg, level=level)
    except Exception:  # pragma: no cover
        _log.exception("sentry.capture_message failed")


def _reset_for_tests() -> None:
    """Test-only hook: clear the enabled flag between cases."""
    global _ENABLED
    _ENABLED = False
