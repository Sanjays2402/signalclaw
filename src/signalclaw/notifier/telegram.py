from __future__ import annotations
import httpx
from ..config import get_settings
from ..logging_ import get_logger
from .base import Notifier

log = get_logger(__name__)


class TelegramNotifier(Notifier):
    def __init__(self, bot_token: str | None = None, chat_id: str | None = None,
                 enabled: bool | None = None):
        s = get_settings()
        self.bot_token = bot_token if bot_token is not None else s.telegram_bot_token
        self.chat_id = chat_id if chat_id is not None else s.telegram_chat_id
        self.enabled = s.telegram_enabled if enabled is None else enabled

    def send(self, text: str) -> bool:
        payload = {"chat_id": self.chat_id, "text": text[:4000], "parse_mode": "Markdown"}
        if not self.enabled or not self.bot_token or not self.chat_id:
            log.info("telegram.disabled.sample_payload", payload=payload)
            return False
        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        try:
            r = httpx.post(url, json=payload, timeout=10.0)
            r.raise_for_status()
            return True
        except Exception as e:  # noqa
            log.warning("telegram.send.fail", err=str(e))
            return False
