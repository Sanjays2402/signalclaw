from __future__ import annotations
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.resources import Resource

_initialized = False


def init_tracing(service: str = "signalclaw", endpoint: str = "") -> None:
    global _initialized
    if _initialized:
        return
    provider = TracerProvider(resource=Resource.create({"service.name": service}))
    trace.set_tracer_provider(provider)
    _initialized = True
