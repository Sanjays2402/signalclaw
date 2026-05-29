from __future__ import annotations
import httpx
from ..config import get_settings
from ..logging_ import get_logger
from .base import Notifier

log = get_logger(__name__)


class DiscordNotifier(Notifier):
    def __init__(self, webhook_url: str | None = None):
        self.webhook_url = webhook_url if webhook_url is not None else get_settings().discord_webhook_url

    def send(self, text: str) -> bool:
        if not self.webhook_url:
            log.info("discord.disabled.sample_payload", content=text[:200])
            return False
        try:
            r = httpx.post(self.webhook_url, json={"content": text[:1900]}, timeout=10.0)
            r.raise_for_status()
            return True
        except Exception as e:  # noqa
            log.warning("discord.send.fail", err=str(e))
            return False
