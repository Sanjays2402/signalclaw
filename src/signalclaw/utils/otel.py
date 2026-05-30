"""OpenTelemetry tracing bootstrap.

Wires a real OTLP/HTTP span exporter and instruments FastAPI + httpx
when an exporter endpoint is configured. When the endpoint is empty
(the default for personal/dev installs) the function still installs a
TracerProvider with a deterministic service.name so application code
that calls ``trace.get_tracer(__name__).start_as_current_span(...)``
keeps working as a no-op without raising. This avoids two failure
modes: a silently-broken tracer in production, and a hard import-time
crash when OTLP packages are absent.

Env knobs (all optional):

* ``OTEL_EXPORTER_OTLP_ENDPOINT`` - collector base URL. When set, the
  OTLP/HTTP exporter is attached and a ``BatchSpanProcessor`` ships
  spans. When empty, no exporter is attached and tracing is a no-op.
* ``OTEL_TRACES_SAMPLER_ARG`` - parent-based ratio sampler argument in
  ``[0.0, 1.0]``. Defaults to ``1.0`` so local debug traces are
  always recorded; production deployments should turn this down.
* ``OTEL_SERVICE_VERSION`` - optional resource attribute. Defaults to
  the SignalClaw package version when discoverable, else ``"0.0.0"``.

The module is idempotent: re-calling ``init_tracing`` returns the same
provider without registering duplicate exporters or instrumentations.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

_log = logging.getLogger(__name__)

_initialized = False
_provider: Optional[TracerProvider] = None
_httpx_instrumented = False


def _resolve_version() -> str:
    """Best-effort lookup of the SignalClaw distribution version."""
    override = os.environ.get("OTEL_SERVICE_VERSION", "").strip()
    if override:
        return override
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("signalclaw")
        except PackageNotFoundError:
            return "0.0.0"
    except Exception:  # pragma: no cover - defensive
        return "0.0.0"


def _resolve_sampler() -> ParentBased:
    raw = os.environ.get("OTEL_TRACES_SAMPLER_ARG", "1.0").strip()
    try:
        ratio = float(raw)
    except ValueError:
        ratio = 1.0
    if ratio < 0.0:
        ratio = 0.0
    elif ratio > 1.0:
        ratio = 1.0
    return ParentBased(root=TraceIdRatioBased(ratio))


def init_tracing(service: str = "signalclaw", endpoint: str = "") -> TracerProvider:
    """Initialise the global tracer provider.

    Returns the active :class:`TracerProvider` so callers can attach
    additional span processors in tests. Safe to call multiple times.
    """
    global _initialized, _provider
    if _initialized and _provider is not None:
        return _provider

    resource = Resource.create(
        {
            "service.name": service,
            "service.version": _resolve_version(),
            "deployment.environment": os.environ.get(
                "SIGNALCLAW_ENV", os.environ.get("SENTRY_ENVIRONMENT", "development")
            ),
        }
    )
    provider = TracerProvider(resource=resource, sampler=_resolve_sampler())

    endpoint = (endpoint or "").strip()
    if endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )

            # OTLP/HTTP expects the full traces endpoint. Accept either
            # the bare collector base (append /v1/traces) or the full
            # path if the operator already provided it.
            traces_url = endpoint
            if not traces_url.rstrip("/").endswith("/v1/traces"):
                traces_url = traces_url.rstrip("/") + "/v1/traces"
            exporter = OTLPSpanExporter(endpoint=traces_url)
            provider.add_span_processor(BatchSpanProcessor(exporter))
            _log.info("otel.exporter.enabled", extra={"endpoint": traces_url})
        except Exception as exc:  # pragma: no cover - depends on optional deps
            _log.warning("otel.exporter.disabled: %s", exc)

    trace.set_tracer_provider(provider)
    _provider = provider
    _initialized = True
    return provider


def instrument_fastapi(app) -> None:
    """Attach the FastAPI instrumentor to ``app`` exactly once per app.

    The OTel FastAPI instrumentor sets ``_is_instrumented_by_opentelemetry``
    on the app object; we mirror that check so calling create_app many
    times (tests, multi-worker reloads) does not double-wrap.
    """
    if getattr(app, "_is_instrumented_by_opentelemetry", False):
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        # Exclude noisy infra paths from span creation. Metrics and
        # health probes fire constantly and would dominate trace volume
        # without adding signal.
        FastAPIInstrumentor.instrument_app(
            app,
            excluded_urls="/health,/ready,/metrics",
        )
    except Exception as exc:  # pragma: no cover - optional dep
        _log.warning("otel.fastapi.disabled: %s", exc)


def instrument_httpx() -> None:
    """Install the global httpx instrumentation once."""
    global _httpx_instrumented
    if _httpx_instrumented:
        return
    try:
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

        HTTPXClientInstrumentor().instrument()
        _httpx_instrumented = True
    except Exception as exc:  # pragma: no cover - optional dep
        _log.warning("otel.httpx.disabled: %s", exc)


def _reset_for_tests() -> None:
    """Test-only hook: clear the module-level singletons.

    Re-importing the module is awkward in pytest because other modules
    cache the ``trace`` API. This helper lets tests restart the tracer
    provider with a different configuration without process restart.
    Not part of the public API.
    """
    global _initialized, _provider, _httpx_instrumented
    _initialized = False
    _provider = None
    _httpx_instrumented = False
