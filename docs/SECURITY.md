# Security notes

- API gated by `SIGNALCLAW_API_KEY` header.
- Dashboard requires the same key entered into localStorage.
- Telegram/Discord disabled by default; only sample payloads are logged.
- No secrets in repo. `.env.example` shows variable names only.
