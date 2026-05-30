"""Production secret validation in Settings.

Confirms the model_validator on Settings refuses to boot in
production/staging when known-weak sample values are present, and stays
permissive in development/test.
"""
from __future__ import annotations

import importlib

import pytest
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    # Strip every env var the Settings model reads so each test starts from
    # a clean slate regardless of what the host shell or .env file injected.
    for var in (
        "SIGNALCLAW_ENV",
        "SIGNALCLAW_API_KEY",
        "SIGNALCLAW_DASHBOARD_PASSWORD",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_ENABLED",
        "SENTRY_DSN",
        "SENTRY_ENVIRONMENT",
    ):
        monkeypatch.delenv(var, raising=False)
    yield


def _fresh_settings_cls():
    from signalclaw.config import settings as mod
    importlib.reload(mod)
    return mod.Settings


def test_development_accepts_weak_defaults():
    Settings = _fresh_settings_cls()
    # No env overrides means dev defaults; this must boot.
    s = Settings()
    assert s.environment == "development"
    assert s.api_key == "dev-key"
    assert not s.is_production


def test_production_rejects_sample_api_key(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "change-me-local-dev-only")
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "a-real-strong-password-xyz")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError) as exc:
        Settings()
    assert "SIGNALCLAW_API_KEY" in str(exc.value)


def test_production_rejects_short_api_key(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "abc123")  # 6 chars, below the 16 minimum
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "a-real-strong-password-xyz")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError) as exc:
        Settings()
    assert "shorter than the minimum" in str(exc.value)


def test_production_rejects_sample_dashboard_password(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k" * 32)
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "change-me")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError) as exc:
        Settings()
    assert "SIGNALCLAW_DASHBOARD_PASSWORD" in str(exc.value)


def test_production_rejects_sentry_env_mismatch(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k" * 32)
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "p" * 32)
    monkeypatch.setenv("SENTRY_DSN", "https://abc@example.ingest.sentry.io/1")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "development")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError) as exc:
        Settings()
    assert "SENTRY_ENVIRONMENT" in str(exc.value)


def test_production_rejects_telegram_enabled_without_token(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k" * 32)
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "p" * 32)
    monkeypatch.setenv("TELEGRAM_ENABLED", "true")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError) as exc:
        Settings()
    assert "TELEGRAM_BOT_TOKEN" in str(exc.value)


def test_production_accepts_strong_secrets(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "production")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "k" * 32)
    monkeypatch.setenv("SIGNALCLAW_DASHBOARD_PASSWORD", "p" * 32)
    Settings = _fresh_settings_cls()
    s = Settings()
    assert s.is_production
    assert s.environment == "production"


def test_staging_is_strict_like_production(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "staging")
    monkeypatch.setenv("SIGNALCLAW_API_KEY", "dev-key")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError):
        Settings()


def test_unknown_environment_value_rejected(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_ENV", "uat")
    Settings = _fresh_settings_cls()
    with pytest.raises(ValidationError):
        Settings()
