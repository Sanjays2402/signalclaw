"""Observability helpers: error tracking + tracing wiring.

Right now this package owns the Sentry integration. OpenTelemetry
tracing lives in ``signalclaw.utils.otel`` for historical reasons; we
re-export the Sentry surface here so callers can ``from
signalclaw.observability import init_sentry`` without poking into a
submodule.
"""
from .sentry import (
    SentryConfig,
    init_sentry,
    is_enabled,
    capture_exception,
    capture_message,
)

__all__ = [
    "SentryConfig",
    "init_sentry",
    "is_enabled",
    "capture_exception",
    "capture_message",
]
