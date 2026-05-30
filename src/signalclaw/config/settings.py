from __future__ import annotations
from functools import lru_cache
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    api_key: str = Field(default="dev-key", alias="SIGNALCLAW_API_KEY")
    dashboard_password: str = Field(default="dev-pass", alias="SIGNALCLAW_DASHBOARD_PASSWORD")
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_chat_id: str = Field(default="", alias="TELEGRAM_CHAT_ID")
    telegram_enabled: bool = Field(default=False, alias="TELEGRAM_ENABLED")
    discord_webhook_url: str = Field(default="", alias="DISCORD_WEBHOOK_URL")
    newsapi_key: str = Field(default="", alias="NEWSAPI_KEY")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    data_dir: Path = Field(default=Path("./data"), alias="DATA_DIR")
    enable_ci: bool = Field(default=False, alias="ENABLE_CI")
    otel_endpoint: str = Field(default="", alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    earnings_blackout_days: int = Field(default=5, alias="SIGNALCLAW_EARNINGS_BLACKOUT_DAYS")

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
