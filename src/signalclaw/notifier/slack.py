"""Slack incoming-webhook notifier."""
from __future__ import annotations
import httpx
from ..config import get_settings
from ..logging_ import get_logger
from .base import Notifier

log = get_logger(__name__)


class SlackNotifier(Notifier):
    """Posts to a Slack incoming webhook URL.

    URL is read from settings.slack_webhook_url unless overridden. When the
    URL is empty the notifier logs a sample payload and returns False (same
    convention as the other notifiers) so the rest of the pipeline can keep
    running in dry-run mode.
    """

    def __init__(self, webhook_url: str | None = None, channel: str | None = None):
        s = get_settings()
        if webhook_url is not None:
            self.webhook_url = webhook_url
        else:
            self.webhook_url = getattr(s, "slack_webhook_url", "") or ""
        self.channel = channel  # optional override; many webhook URLs ignore this

    def send(self, text: str) -> bool:
        if not self.webhook_url:
            log.info("slack.disabled.sample_payload", text=text[:200])
            return False
        payload: dict = {"text": text[:3500]}
        if self.channel:
            payload["channel"] = self.channel
        try:
            r = httpx.post(self.webhook_url, json=payload, timeout=10.0)
            r.raise_for_status()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("slack.send.fail", err=str(e))
            return False
