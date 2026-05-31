# Security Policy

SignalClaw takes security seriously. This document covers how to report
issues, what we commit to in response, and how the platform handles
credentials, tenant data, and incident response.

## Supported Versions

Only the `main` branch and the latest tagged release receive security
fixes. Older builds are not patched.

| Version            | Supported |
| ------------------ | --------- |
| `main` (rolling)   | yes       |
| Latest tagged      | yes       |
| Anything older     | no        |

## Reporting a Vulnerability

Please email security reports to `security@signalclaw.example` (or open
a GitHub private vulnerability report on this repository). Include:

- A clear description of the issue and impact.
- A minimal reproduction (curl, code, or steps).
- Affected endpoint, commit, or version if known.
- Whether the issue has been disclosed elsewhere.

Please do not open public GitHub issues for suspected vulnerabilities.

We acknowledge new reports within **2 business days** and aim to ship a
fix or mitigation for confirmed high-severity issues within **14 days**.
We will credit reporters in the release notes unless they ask to remain
anonymous.

## Scope

In scope: the API service in `services/api`, the Next.js dashboard in
`web/`, the signal engine in `services/signal-engine`, and the persisted
state under `data/` (API keys, watchlist, alerts, audit log, webhook
delivery log, MFA enrollments).

Out of scope: third-party data providers, end-user broker integrations,
and self-hosted deployments operated by other parties.

## What We Already Do

- API keys are hashed at rest (SHA-256) and never logged.
- Per-key scopes (`read`, `trade`, `admin`) gate every mutating route.
- Per-key IP allowlists (CIDR), per-key rate limits, and per-IP DoS
  guards run as middleware on every request.
- TOTP MFA gates every admin endpoint when enrolled.
- API keys carry a hard expiry; rotation supports a bounded grace
  window so live integrations roll over without downtime.
- Every authenticated request is recorded in a tamper-evident audit
  log (`data/audit/*.jsonl`) with actor, action, target, IP, and a
  chained hash so any tampering is detectable.
- Webhook deliveries are HMAC-signed with replay protection, retried
  with exponential backoff, and persisted for byte-exact replay.
- Sandbox / dry-run mode is supported on every mutating endpoint via
  `?dry_run=true`.
- Request IDs propagate end-to-end and are echoed back as
  `X-Request-Id` on every response.

## Credential Handling

- Never commit secrets, API keys, or `.env` files. Pre-commit and CI
  should refuse anything matching a high-entropy secret pattern.
- Operators set `SIGNALCLAW_API_KEYS_JSON` or use the persisted
  `data/api_keys.json` store. Both paths hash secrets before storage.
- Force-rotate any leaked key via `DELETE /admin/keys/{id}` followed by
  `POST /admin/keys` to mint a replacement.

## Disclosure

We follow coordinated disclosure. We will not pursue legal action
against good-faith researchers who:

1. Give us reasonable time to investigate and patch.
2. Do not access, modify, or exfiltrate data beyond what is needed to
   demonstrate the issue.
3. Do not run automated scanners that degrade service for other users.

Thank you for helping keep SignalClaw users safe.
