"""Prometheus metrics for the SignalClaw API.

Exposes a ``/metrics`` endpoint in the standard text exposition format
and an HTTP middleware that records per-route request counts and
latency. Route labels use the FastAPI route template (for example
``/picks`` or ``/alerts/{alert_id}``) so cardinality stays bounded even
when callers hit many distinct path values.

The module also exports a tiny health helper used by the ``/ready``
endpoint to confirm the data directory is writable before declaring the
process ready to serve traffic. ``/health`` stays as a cheap liveness
probe in ``app.py``.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Iterable

from fastapi import FastAPI, Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
    multiprocess,
)
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


# Buckets cover the realistic latency range for this API: sub-ms cached
# responses, low-tens-of-ms json reads, and multi-second backtest
# fanouts. Keeping these aligned with the SLO docs avoids re-tuning
# Grafana panels later.
_LATENCY_BUCKETS = (
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
)


def build_registry() -> CollectorRegistry:
    """Return a fresh collector registry.

    A dedicated registry (rather than the global default) keeps tests
    isolated and avoids ``Duplicated timeseries`` errors when
    ``create_app`` is called more than once in the same process.
    """
    return CollectorRegistry()


class MetricsRecorder:
    """Container for the per-app Prometheus collectors."""

    def __init__(self, registry: CollectorRegistry) -> None:
        self.registry = registry
        self.requests_total = Counter(
            "signalclaw_http_requests_total",
            "Count of HTTP requests handled by the SignalClaw API.",
            labelnames=("method", "route", "status"),
            registry=registry,
        )
        self.request_duration = Histogram(
            "signalclaw_http_request_duration_seconds",
            "Wall-clock duration of HTTP requests, in seconds.",
            labelnames=("method", "route"),
            buckets=_LATENCY_BUCKETS,
            registry=registry,
        )
        self.in_flight = Gauge(
            "signalclaw_http_in_flight_requests",
            "Number of HTTP requests currently being served.",
            registry=registry,
        )
        self.build_info = Gauge(
            "signalclaw_build_info",
            "Static build info; value is always 1.",
            labelnames=("version",),
            registry=registry,
        )

    def record(self, method: str, route: str, status: int, duration_s: float) -> None:
        m = method.upper()
        self.requests_total.labels(method=m, route=route, status=str(status)).inc()
        self.request_duration.labels(method=m, route=route).observe(duration_s)


def _resolve_route_template(request: Request, fallback: str) -> str:
    """Return the matched FastAPI route template, or a stable fallback.

    Without this, every distinct path (for example ``/alerts/abc123``
    and ``/alerts/def456``) would be its own time series. The route
    template collapses them to ``/alerts/{alert_id}``.
    """
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if path:
        return str(path)
    # Unmatched paths (404s, etc.) bucket together so cardinality stays
    # bounded even under scanner traffic.
    return fallback


class PrometheusMiddleware(BaseHTTPMiddleware):
    """Record request count, latency, and in-flight gauge.

    Excludes ``/metrics`` itself so scrapes do not pollute the data.
    """

    def __init__(self, app, recorder: MetricsRecorder, exempt: Iterable[str] = ("/metrics",)) -> None:
        super().__init__(app)
        self._recorder = recorder
        self._exempt = tuple(exempt)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path == p or path.startswith(p + "/") for p in self._exempt):
            return await call_next(request)
        self._recorder.in_flight.inc()
        t0 = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        except Exception:
            # Status stays 500; framework will surface the error. We
            # still want the metric so spikes are visible in Grafana.
            raise
        finally:
            duration = time.perf_counter() - t0
            route = _resolve_route_template(request, fallback="__unmatched__")
            self._recorder.record(request.method, route, status, duration)
            self._recorder.in_flight.dec()


def install_metrics(app: FastAPI, version: str) -> MetricsRecorder:
    """Wire metrics into a FastAPI app.

    Adds ``PrometheusMiddleware``, mounts a ``/metrics`` endpoint, and
    seeds ``signalclaw_build_info`` so dashboards can pin version.
    """
    registry = build_registry()
    recorder = MetricsRecorder(registry)
    recorder.build_info.labels(version=version).set(1)
    app.add_middleware(PrometheusMiddleware, recorder=recorder)

    @app.get("/metrics", include_in_schema=False)
    def metrics() -> Response:
        # Prometheus expects a text body with this specific content type.
        payload = generate_latest(registry)
        return Response(content=payload, media_type=CONTENT_TYPE_LATEST)

    # Stash for tests / introspection.
    app.state.metrics = recorder
    return recorder


def data_dir_ready(data_dir: Path) -> bool:
    """Return True if ``data_dir`` exists and is writable.

    Used by ``/ready`` to fail closed when the persistent volume is
    misconfigured (for example, a Helm values typo, or a PVC that
    failed to mount). ``/health`` remains a cheap liveness check that
    does not touch the filesystem.
    """
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        probe = data_dir / ".ready_probe"
        probe.write_text("ok")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


# multiprocess kept importable for future gunicorn deployments; silence
# unused-import lints without re-exporting at module top.
__all__ = [
    "MetricsRecorder",
    "PrometheusMiddleware",
    "install_metrics",
    "data_dir_ready",
    "build_registry",
    "multiprocess",
]
