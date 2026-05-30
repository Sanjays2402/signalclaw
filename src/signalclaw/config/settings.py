from __future__ import annotations
from functools import lru_cache
from pathlib import Path
from typing import List, Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Known-weak default values that ship in .env.example and source defaults.
# If any of these survive into a production boot we refuse to start so a
# misconfigured deploy fails loudly instead of silently exposing a stub key.
_WEAK_API_KEYS = {
    "",
    "dev-key",
    "change-me",
    "change-me-local-dev-only",
    "changeme",
    "test",
    "secret",
}
_WEAK_DASHBOARD_PASSWORDS = {
    "",
    "dev-pass",
    "change-me",
    "changeme",
    "password",
    "admin",
}

# Minimum acceptable length for production secrets. Short keys are
# trivially brute-forceable regardless of whether they match the
# explicit blocklist above.
_MIN_SECRET_LEN = 16


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Deployment environment. Production triggers strict secret validation
    # in ``_validate_production_secrets`` below. Staging is treated like
    # production for safety. Development and test allow weak defaults so
    # local boots and CI keep working.
    environment: Literal["development", "test", "staging", "production"] = Field(
        default="development", alias="SIGNALCLAW_ENV"
    )

    api_key: str = Field(default="dev-key", alias="SIGNALCLAW_API_KEY")
    dashboard_password: str = Field(default="dev-pass", alias="SIGNALCLAW_DASHBOARD_PASSWORD")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str = Field(default="", alias="TELEGRAM_CHAT_ID")
    telegram_enabled: bool = Field(default=False, alias="TELEGRAM_ENABLED")
    discord_webhook_url: str = Field(default="", alias="DISCORD_WEBHOOK_URL")
    slack_webhook_url: str = Field(default="", alias="SLACK_WEBHOOK_URL")
    newsapi_key: str = Field(default="", alias="NEWSAPI_KEY")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")
    enable_ci: bool = Field(default=False, alias="ENABLE_CI")
    otel_endpoint: str = Field(default="", alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    sentry_dsn: str = Field(default="", alias="SENTRY_DSN")
    sentry_environment: str = Field(default="development", alias="SENTRY_ENVIRONMENT")
    sentry_traces_sample_rate: float = Field(default=0.0, alias="SENTRY_TRACES_SAMPLE_RATE")
    earnings_blackout_days: int = Field(default=5, alias="SIGNALCLAW_EARNINGS_BLACKOUT_DAYS")

    @property
    def is_production(self) -> bool:
        return self.environment in ("production", "staging")

    @model_validator(mode="after")
    def _validate_production_secrets(self) -> "Settings":
        """Refuse to boot in production when known-weak secrets are present.

        This is the last line of defense against deploying with the
        sample values from .env.example. It checks:

        * SIGNALCLAW_API_KEY is not in the weak blocklist and is long
          enough to resist trivial brute force.
        * SIGNALCLAW_DASHBOARD_PASSWORD is not a sample value and meets
          the minimum length.
        * SENTRY_ENVIRONMENT is not still 'development' when the app
          environment is production (mismatch indicates a copy-paste).

        Raises ValueError so pydantic surfaces a structured validation
        error to the caller. Development and test environments skip
        the check so local workflows stay frictionless.
        """
        if not self.is_production:
            return self

        problems: List[str] = []

        if self.api_key.strip().lower() in _WEAK_API_KEYS:
            problems.append(
                "SIGNALCLAW_API_KEY is set to a known sample value; rotate it before booting in production"
            )
        elif len(self.api_key) < _MIN_SECRET_LEN:
            problems.append(
                f"SIGNALCLAW_API_KEY is shorter than the minimum {_MIN_SECRET_LEN} characters required in production"
            )

        if self.dashboard_password.strip().lower() in _WEAK_DASHBOARD_PASSWORDS:
            problems.append(
                "SIGNALCLAW_DASHBOARD_PASSWORD is set to a known sample value; rotate it before booting in production"
            )
        elif len(self.dashboard_password) < _MIN_SECRET_LEN:
            problems.append(
                "SIGNALCLAW_DASHBOARD_PASSWORD is shorter than the minimum "
                f"{_MIN_SECRET_LEN} characters required in production"
            )

        if self.sentry_dsn and self.sentry_environment.lower() in ("development", "dev", "local"):
            problems.append(
                "SENTRY_ENVIRONMENT is still 'development' while SIGNALCLAW_ENV is production; "
                "errors would be tagged with the wrong environment"
            )

        if self.telegram_enabled and not self.telegram_bot_token:
            problems.append(
                "TELEGRAM_ENABLED is true but TELEGRAM_BOT_TOKEN is empty; Telegram delivery would silently fail"
            )

        if problems:
            joined = "; ".join(problems)
            raise ValueError(
                "Refusing to start: insecure or inconsistent configuration for "
                f"SIGNALCLAW_ENV={self.environment}. Fix the following: {joined}"
            )
        return self

    @property
    def parquet_dir(self) -> Path:
        p = self.data_dir / "parquet"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cache_dir(self) -> Path:
        p = self.data_dir / "cache"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def artifacts_dir(self) -> Path:
        p = self.data_dir / "artifacts"
        p.mkdir(parents=True, exist_ok=True)
        return p


@lru_cache
def get_settings() -> Settings:
    return Settings()
