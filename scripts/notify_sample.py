"""Print a sample Telegram payload without sending. Useful to verify formatting."""
from signalclaw.engine import run_daily, render_markdown
from signalclaw.notifier import TelegramNotifier

if __name__ == "__main__":
    rep = run_daily(refresh=False)
    md = render_markdown(rep)
    TelegramNotifier(enabled=False).send(md)
    print(md)
