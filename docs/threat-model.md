# Threat Model

A short STRIDE-style threat model for the SignalClaw API service,
dashboard, and signal engine. Reviewed quarterly or after any change
to the auth, audit, or webhooks surface.

## Assets

1. API keys (hashed at rest; secrets exist in operator memory only).
2. Persisted user state under `data/`: watchlist, alerts, portfolio,
   stops, brackets, journal, ledger, scaling plans, news events,
   webhook subscriptions, webhook delivery log, audit log, MFA
   enrollments.
3. Audit log integrity (chained hash; tampering must be detectable).
4. Outbound webhooks (signed HMAC; replay-safe).
5. Operator credentials for upstream data providers.

## Trust Boundaries

- Public network to API ingress.
- API process to disk-backed JSON stores.
- API process to outbound webhook targets.
- Operator browser to dashboard to API.

## STRIDE

### Spoofing

| Threat | Mitigation |
| --- | --- |
| Forged API key | Keys are 32-byte URL-safe secrets; only the SHA-256 is stored; `ApiKeyStore.lookup` is constant-time at the hash layer. |
| Replayed webhook to a downstream | Outbound deliveries carry HMAC-SHA256 over body and a nonce; receivers verify both. |
| Forged `X-Request-Id` to poison logs | Inbound `X-Request-Id` is regex-validated; invalid values are dropped and a fresh id minted. |

### Tampering

| Threat | Mitigation |
| --- | --- |
| Audit log edits to hide an action | Audit lines are chained: each line hashes the previous hash plus its payload. Any edit breaks the chain and is detectable by `signalclaw audit verify`. |
| State-file mutation by another process | All stores write through a per-store lock and write to a tmp file before rename. Disk-level integrity is the operator's responsibility (FDE recommended). |
| Forged dry-run that hides side effects | Dry-run is enforced in the route handler before any store mutation; audit records every dry-run probe so a sandbox bypass is visible. |

### Repudiation

| Threat | Mitigation |
| --- | --- |
| Operator denies running a destructive call | Every authenticated request is audited with actor key id, action, target, IP, user agent, status, request id, and timestamp. The chain hash prevents post-hoc deletion. |

### Information Disclosure

| Threat | Mitigation |
| --- | --- |
| API key value in logs | The middleware redacts `x-api-key`; only the key id and prefix are logged. |
| Cross-tenant leakage | Single-tenant deployments today; the multi-tenancy plan is tracked in `docs/roadmap.md`. Operators running multi-tenant should deploy one process per tenant until tenant scoping ships. |
| Privacy export leaking other accounts | `/privacy/export` is gated by the `admin` scope and MFA; the export is scoped to the calling deployment's data directory. |

### Denial of Service

| Threat | Mitigation |
| --- | --- |
| Single noisy IP | `PerIPRateLimitMiddleware` sheds floods before auth runs. Default 600 rpm; tunable per deployment. |
| Single noisy key | Per-key rate limits enforce `X-RateLimit-*` headers and return 429 with `Retry-After`. |
| Webhook destination hanging the worker | Outbound deliveries have a hard timeout and a bounded retry budget; the delivery log records the failure for replay. |

### Elevation of Privilege

| Threat | Mitigation |
| --- | --- |
| Read key minting itself a trade or admin key | `POST /admin/keys` requires the `admin` scope plus MFA; the route also strips `admin` from any user-supplied scope list as defence in depth. |
| Long-lived stolen admin key | Keys carry a hard expiry (default cap enforced on create); rotation supports a grace window so credentials can roll without downtime. |
| Admin endpoint hit from a stolen workstation | TOTP MFA gate on every admin endpoint when enrolled; `SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN=1` enforces enrollment for procurement mode. |

## Out of Scope (for now)

- Multi-tenant data isolation at the query layer. Tracked; single-tenant
  per process today.
- SSO / SAML / OIDC. Tracked; today operators bring their own identity
  via API keys and MFA.
- Hardware-backed key storage. Operators should run with FDE and treat
  `data/` as sensitive.

## Review Cadence

- Quarterly review by the repository owner.
- Triggered review after any change to: `src/signalclaw/api/`,
  `src/signalclaw/api_keys/`, `src/signalclaw/audit/`,
  `src/signalclaw/mfa/`, or `src/signalclaw/webhooks/`.
