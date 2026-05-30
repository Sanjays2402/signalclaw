"""Tests for the Sentry observability wiring.

Covers the three behaviours that matter operationally:

1. With no DSN set, ``init_sentry`` is a safe no-op and helpers stay
   inert. This is the default everywhere except production, so any
   regression here would silently disable error tracking.
2. ``SentryConfig.from_env`` parses + clamps values defensively so a
   typo in env config cannot crash startup.
3. With a DSN set, ``init_sentry`` invokes the SDK with the expected
   FastAPI/Starlette integrations and flips ``is_enabled`` to True.
   We stub the SDK module so the test does not require network access.
"""
from __future__ import annotations

import sys
import types

import pytest

from signalclaw.observability import sentry as sentry_mod
from signalclaw.observability.sentry import (
    SentryConfig,
    capture_exception,
    capture_message,
    init_sentry,
    is_enabled,
)


@pytest.fixture(autouse=True)
def _reset():
    sentry_mod._reset_for_tests()
    yield
    sentry_mod._reset_for_tests()


def test_disabled_by_default_no_dsn():
    cfg = SentryConfig.from_env(env={})
    assert cfg.dsn == ""
    assert init_sentry(cfg) is False
    assert is_enabled() is False
    # Helpers must be safe to call when disabled.
    capture_exception(RuntimeError("boom"))
    capture_message("hello", level="warning")


def test_from_env_parses_and_clamps():
    cfg = SentryConfig.from_env(env={
        "SENTRY_DSN": "https://abc@o1.ingest.sentry.io/1",
        "SENTRY_ENVIRONMENT": "production",
        "SENTRY_RELEASE": "0.1.0",
        "SENTRY_TRACES_SAMPLE_RATE": "0.25",
        "SENTRY_PROFILES_SAMPLE_RATE": "5.0",  # clamped to 1.0
        "SENTRY_SEND_DEFAULT_PII": "true",
    })
    assert cfg.dsn.startswith("https://")
    assert cfg.environment == "production"
    assert cfg.release == "0.1.0"
    assert cfg.traces_sample_rate == 0.25
    assert cfg.profiles_sample_rate == 1.0
    assert cfg.send_default_pii is True


def test_from_env_invalid_floats_fall_back():
    cfg = SentryConfig.from_env(env={
        "SENTRY_DSN": "https://x@o1.ingest.sentry.io/1",
        "SENTRY_TRACES_SAMPLE_RATE": "not-a-number",
        "SENTRY_PROFILES_SAMPLE_RATE": "-1",
    })
    assert cfg.traces_sample_rate == 0.0
    assert cfg.profiles_sample_rate == 0.0


def test_init_with_stub_sdk(monkeypatch):
    captured = {}

    def fake_init(**kwargs):
        captured.update(kwargs)

    fake_sdk = types.ModuleType("sentry_sdk")
    fake_sdk.init = fake_init  # type: ignore[attr-defined]
    fake_sdk.capture_exception = lambda exc: captured.setdefault("exc", exc)  # type: ignore[attr-defined]
    fake_sdk.capture_message = lambda msg, level=None: captured.setdefault("msg", (msg, level))  # type: ignore[attr-defined]

    def _mk_integration(name):
        mod = types.ModuleType(name)
        cls_name = name.rsplit(".", 1)[-1].title().replace("_", "") + "Integration"
        # Build a class whose constructor accepts arbitrary kwargs.
        cls = type(cls_name, (), {"__init__": lambda self, **kw: None})
        setattr(mod, cls_name, cls)
        return mod

    fastapi_mod = types.ModuleType("sentry_sdk.integrations.fastapi")
    fastapi_mod.FastApiIntegration = type("FastApiIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    starlette_mod = types.ModuleType("sentry_sdk.integrations.starlette")
    starlette_mod.StarletteIntegration = type("StarletteIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    logging_mod = types.ModuleType("sentry_sdk.integrations.logging")
    logging_mod.LoggingIntegration = type("LoggingIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    integrations_pkg = types.ModuleType("sentry_sdk.integrations")

    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sdk)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations", integrations_pkg)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.fastapi", fastapi_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.starlette", starlette_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.logging", logging_mod)

    cfg = SentryConfig(
        dsn="https://abc@o1.ingest.sentry.io/1",
        environment="staging",
        traces_sample_rate=0.1,
    )
    assert init_sentry(cfg) is True
    assert is_enabled() is True
    assert captured["dsn"] == cfg.dsn
    assert captured["environment"] == "staging"
    assert captured["traces_sample_rate"] == 0.1
    assert captured["send_default_pii"] is False
    assert callable(captured["before_send"])
    # Helpers now route through the stub.
    capture_exception(ValueError("x"))
    assert isinstance(captured.get("exc"), ValueError)
    capture_message("ping", level="warning")
    assert captured.get("msg") == ("ping", "warning")


def test_before_send_redacts_secrets(monkeypatch):
    # Reach the private scrubber via init path with a stub SDK.
    captured = {}

    def fake_init(**kwargs):
        captured.update(kwargs)

    fake_sdk = types.ModuleType("sentry_sdk")
    fake_sdk.init = fake_init  # type: ignore[attr-defined]
    fastapi_mod = types.ModuleType("sentry_sdk.integrations.fastapi")
    fastapi_mod.FastApiIntegration = type("FastApiIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    starlette_mod = types.ModuleType("sentry_sdk.integrations.starlette")
    starlette_mod.StarletteIntegration = type("StarletteIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    logging_mod = types.ModuleType("sentry_sdk.integrations.logging")
    logging_mod.LoggingIntegration = type("LoggingIntegration", (), {"__init__": lambda self, **kw: None})  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentry_sdk", fake_sdk)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations", types.ModuleType("sentry_sdk.integrations"))
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.fastapi", fastapi_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.starlette", starlette_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.logging", logging_mod)

    init_sentry(SentryConfig(dsn="https://x@o1.ingest.sentry.io/1"))
    scrub = captured["before_send"]
    event = {
        "request": {
            "headers": {"Authorization": "Bearer secret", "X-Api-Key": "sk_live", "User-Agent": "ua"},
            "data": {"password": "hunter2"},
            "json": {"k": "v"},
        }
    }
    out = scrub(event, {})
    headers = out["request"]["headers"]
    assert headers["Authorization"] == "[redacted]"
    assert headers["X-Api-Key"] == "[redacted]"
    assert headers["User-Agent"] == "ua"
    assert out["request"]["data"] == "[redacted]"
    assert out["request"]["json"] == "[redacted]"
