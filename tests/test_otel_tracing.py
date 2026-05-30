"""Tests for the OpenTelemetry tracing wiring.

Covers the real behaviour we ship: a TracerProvider with the correct
service.name resource, an OTLP exporter mounted only when configured,
FastAPI + httpx auto-instrumentation, idempotent re-init, and the
trace_id/span_id propagation into structlog contextvars via the request
middleware.
"""
from __future__ import annotations

import os

import pytest
import structlog
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")

from signalclaw.utils import otel as otel_mod  # noqa: E402
from signalclaw.utils.otel import init_tracing, instrument_httpx  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_otel():
    # Each test gets a fresh provider so add_span_processor calls do
    # not leak across cases. The global trace API is reset between
    # tests to keep instrument_app idempotency honest.
    otel_mod._reset_for_tests()
    yield
    otel_mod._reset_for_tests()


def test_init_tracing_installs_provider_with_service_name():
    provider = init_tracing("signalclaw-test", "")
    assert isinstance(provider, TracerProvider)
    res_attrs = dict(provider.resource.attributes)
    assert res_attrs.get("service.name") == "signalclaw-test"
    # Version resolves to something non-empty, even when the package
    # is not installed under the queried name.
    assert res_attrs.get("service.version")


def test_init_tracing_is_idempotent():
    a = init_tracing("signalclaw-test", "")
    b = init_tracing("signalclaw-test", "")
    assert a is b


def test_init_tracing_skips_exporter_when_endpoint_empty():
    provider = init_tracing("signalclaw-test", "")
    # No span processors mounted means no exporter is shipping data.
    # _active_span_processor is a CompositeSpanProcessor; its private
    # list is the cleanest public-ish way to assert "nothing attached".
    procs = getattr(provider._active_span_processor, "_span_processors", ())
    assert procs == () or len(procs) == 0


def test_init_tracing_mounts_otlp_exporter_when_endpoint_set():
    provider = init_tracing("signalclaw-test", "http://collector.local:4318")
    procs = getattr(provider._active_span_processor, "_span_processors", ())
    assert len(procs) >= 1


def test_request_context_binds_trace_id(monkeypatch):
    # Attach an in-memory exporter to whatever TracerProvider create_app
    # ends up using. The global OTel API refuses to replace a provider
    # once set, so we must take the live one rather than the one
    # init_tracing returned in isolation.
    from signalclaw.api import create_app

    app = create_app()
    provider = trace.get_tracer_provider()
    exporter = InMemorySpanExporter()
    # add_span_processor exists on SDK TracerProvider; the proxy class
    # in the API package does not, so skip cleanly when running against
    # a stub provider (means OTel SDK never initialised).
    if not hasattr(provider, "add_span_processor"):
        pytest.skip("OTel SDK TracerProvider not active")
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    captured: dict[str, str] = {}

    @app.get("/_trace_probe")
    def _probe():
        # The middleware should have bound trace_id into structlog
        # context by the time the handler runs.
        ctx = structlog.contextvars.get_contextvars()
        captured.update({k: v for k, v in ctx.items() if isinstance(v, str)})
        return {"ok": True}

    client = TestClient(app)
    r = client.get("/_trace_probe", headers={"x-api-key": "test-key"})
    assert r.status_code == 200

    spans = exporter.get_finished_spans()
    # FastAPI instrumentation should have produced at least one span
    # for the probe request.
    probe_spans = [s for s in spans if "/_trace_probe" in (s.name or "")]
    assert probe_spans, f"no probe span found in {[s.name for s in spans]}"
    span_ctx = probe_spans[0].get_span_context()
    expected_trace = format(span_ctx.trace_id, "032x")
    assert captured.get("trace_id") == expected_trace
    assert captured.get("request_id")


def test_instrument_httpx_is_idempotent():
    # Calling twice must not raise; the underlying instrumentor refuses
    # double-install and we swallow that as a no-op.
    instrument_httpx()
    instrument_httpx()
