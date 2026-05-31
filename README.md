# SignalClaw

A local-first time-series signal terminal that classifies market regime (bull / chop / bear / crash) and lets you save, share, comment on, and compare runs side by side.

![landing](docs/screenshots/landing.png)

## What's new

- **MFA recovery codes for admin keys**. SOC2 CC6.6 expects a documented account-recovery path, and procurement reviewers fail any product where losing a phone means losing the only admin key. `POST /mfa/confirm` now mints a one-time batch of 10 single-use recovery codes (OCR-friendly `XXXXX-XXXXX` alphabet, no 0/O/1/I) and returns the plaintext exactly once; only SHA-256 hashes are persisted to `<data_dir>/mfa/enrollments.json`, so a backup leak is not enough to bypass MFA. Admins present any unused code as `x-mfa-recovery-code` to unlock any admin route covered by `require_mfa_for_admin`; the code is burned atomically inside the store lock so two concurrent requests with the same code cannot both succeed. `GET /mfa/status` reports `recovery_codes_remaining`, and `POST /mfa/recovery-codes/regenerate` (itself MFA-gated, accepts either TOTP or an unused recovery code) replaces the batch and returns the fresh plaintext exactly once. The `/settings/security` page surfaces a save-once panel with copy-all and a downloadable `.txt` backup, a remaining-count card with low/empty warnings and a Regenerate button, and a one-shot recovery-code field that queues the code on the next admin call and clears it from `sessionStorage` after a single use. Covered by `tests/test_mfa_recovery_codes.py` (confirm returns 10 well-formed codes, a code unlocks `/audit` once and is rejected on reuse, the remaining count drops by exactly one, regenerate wipes the prior batch, and a recursive scan of the on-disk MFA store proves no plaintext code ever leaks to disk).

  Try it locally: `make api` then
  ```bash
  # Enroll, confirm, and save the recovery codes that come back
  curl -s -X POST http://localhost:7431/mfa/enroll \
      -H "x-api-key: $SIGNALCLAW_API_KEY" -d '{}'
  curl -s -X POST http://localhost:7431/mfa/confirm \
      -H "x-api-key: $SIGNALCLAW_API_KEY" \
      -H 'content-type: application/json' \
      -d '{"code":"123456"}' | jq .recovery_codes

  # Lost your phone? Use a recovery code instead of a TOTP
  curl -s http://localhost:7431/audit \
      -H "x-api-key: $SIGNALCLAW_API_KEY" \
      -H "x-mfa-recovery-code: ABCDE-FGHJK"
  ```
  UI: `cd web && pnpm dev` and visit http://localhost:7430/settings/security.

- **Webhook signing secret rotation with a grace window**. SOC2 CC6.1 + CC6.7 want every shared secret to be rotatable on demand without a flag day, and enterprise procurement reviews score the HMAC story specifically on whether receivers can roll their verifier without missed deliveries. `POST /webhooks/{id}/rotate-secret` (tenant-scoped via the existing owner-key gate) replaces the active secret and, when `grace_seconds > 0`, retains the prior secret on the subscription record as `previous_secret` with an absolute `previous_secret_expires_at` cutoff. While the grace window is open every outbound delivery is dual-signed: `X-SignalClaw-Signature` is computed with the new secret and `X-SignalClaw-Signature-Previous` is computed with the prior secret, so receivers can flip their verifier at any point inside the window without dropping events. Once the grace elapses the prior secret is purged on the very next delivery (the record is mutated and persisted in-line) and only the new signature is emitted. Passing `secret: ""` mints a cryptographically random 32-byte hex secret server-side; secrets shorter than 16 chars are rejected at the boundary (`422`); a sibling tenant's id returns `404` (not `403`) so existence does not leak. The `/webhooks` page surfaces a per-row Rotate button, displays the last `secret_rotated_at`, an active grace badge, and a one-time copy panel for the new secret. Covered by `tests/test_webhook_secret_rotation.py` (rotate response and persisted state, blank-secret minting, too-short secret rejection, end-to-end dual signing during grace then drop-after-expiry on the next delivery, and a two-tenant isolation case where Bob's rotate attempt 404s without changing Alice's secret).

  Try it locally: `make api` then
  ```bash
  # Create a webhook (uses the operator key for the example)
  SUB=$(curl -s -X POST http://localhost:7431/webhooks \
      -H "x-api-key: $SIGNALCLAW_API_KEY" \
      -H "content-type: application/json" \
      -d '{"url":"https://example.test/hook","secret":"first-secret-please-rotate"}' | jq -r .id)

  # Rotate to a server-minted secret, keep the old one valid for 1 hour
  curl -s -X POST http://localhost:7431/webhooks/$SUB/rotate-secret \
      -H "x-api-key: $SIGNALCLAW_API_KEY" \
      -H "content-type: application/json" \
      -d '{"secret":"","grace_seconds":3600}' | jq .
  # The new secret is returned on the subscription row at GET /webhooks.
  ```
  UI: `pnpm --filter signalclaw-web dev` and visit http://localhost:7430/webhooks.

- **Per-API-key absolute expiry on the Next admin store**. SOC2 CC6.1 requires that credentials cannot live forever; rotation alone is not enough if there is no enforced cutoff. The Next-side admin key store at `web/lib/keyStore.ts` now persists an optional `expires_at` (ISO 8601 UTC) on every key, accepts it on creation (`POST /api/admin/keys`), and exposes a dedicated `GET`/`PUT /api/admin/keys/{id}/expiry` to set or clear the cutoff on an existing key. The check lives inside `authenticate()` itself, so every Next route, admin or public, sees the same answer: an expired key returns `null` exactly like a revoked key, with no last_used_at bump. Past timestamps are rejected at the boundary (`400 invalid_expiry`), unparseable strings fail the same way, revoked keys cannot be edited (`409 revoked`), and every successful change is written to the audit log with a `expiry:<before>-><after>` reason so a reviewer can prove when the window was set. The exported `publicView` now includes both `expires_at` and a derived `expired` boolean so the dashboard at `/settings/keys` can render the badge without a second round-trip. Covered by `web/tests/keyExpiry.test.mjs` (default is no expiry, future timestamps accepted, past and junk timestamps rejected on both create and update, an authenticated key flips to unauthenticated once its expiry passes, `setKeyExpiry(null)` clears the cutoff, and revoked keys are refused).

  Try it locally: `pnpm --filter signalclaw-web dev` then
  ```bash
  # Create a key that auto-expires in 1 hour
  EXP=$(node -e "console.log(new Date(Date.now()+3600e3).toISOString())")
  curl -X POST http://localhost:7430/api/admin/keys \
    -H 'content-type: application/json' \
    -d "{\"label\":\"ci-runner\",\"scopes\":[\"read\"],\"expires_at\":\"$EXP\"}"

  # Later, extend or clear the cutoff
  curl -X PUT http://localhost:7430/api/admin/keys/$KEY_ID/expiry \
    -H 'content-type: application/json' \
    -d '{"expires_at": null}'
  ```

- **Operator-managed outbound egress policy for the Next webhook system**. The Python `/webhooks` SSRF guard below covers the FastAPI service; the Next.js dashboard at `/webhooks` ships its own delivery pipeline (`web/lib/webhookStore.ts`), and procurement reviewers ask the same question of both: what stops a tenant from pointing a webhook at `169.254.169.254` and using us as an SSRF probe against their own infra? Answer: every Next-side subscription URL is checked against an admin-managed egress policy (`web/lib/egressPolicy.ts`) at create time and again immediately before every outbound POST (including retries), so a DNS rebind between save and send is still blocked. Defaults default-deny on loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16` including the EC2/GCP metadata IP, `fe80::/10`), RFC1918, CGNAT, multicast, IPv6 ULA, IPv4-mapped v6, NAT64, and TEST-NET ranges. Hostnames are resolved with `dns.lookup(host, { all: true })` and every resolved address must clear the deny list. URLs with userinfo (`https://attacker@internal/`) and non-http(s) schemes are rejected outright. Operators can additionally pin destinations to a positive CIDR allowlist (capped at 64 entries, IPv4 + IPv6, canonicalised on write); when non-empty, every resolved IP must fall inside an allowed CIDR. The `allow_private` escape hatch exists for self-hosted dev loops and is off by default. Managed via `GET / PUT /api/admin/webhooks/egress-policy` (admin scope required when `SIGNALCLAW_ADMIN_KEY` is set) and surfaced in the dashboard at `/webhooks` as the “Outbound egress policy” card, with the same `<allow_private>` toggle, CIDR textarea, and saved-by-whom timestamp the security team will screenshot for the audit. Every policy change writes a before/after diff to the audit log with `reason: egress.policy.updated`, and a blocked delivery shows up in the existing delivery log as `egress_blocked:<code>` so reviewers can prove the runtime check is real. Covered by `web/tests/egressPolicy.test.mjs` (scheme rejection, userinfo rejection, IPv4 loopback / RFC1918 / metadata literal, IPv6 loopback + link-local, DNS rebind via test-seam resolver, mixed-answer block, allowlist must-match-all, garbage CIDR rejection on `setPolicy`, `createWebhook` refuses private literals and private resolutions, public destination accepted, and `dispatchEvents` records an `egress_blocked` attempt without calling fetch).

  Try it locally: `cd web && pnpm dev` then visit http://localhost:7430/webhooks and
  ```bash
  # inspect the policy
  curl http://localhost:7430/api/admin/webhooks/egress-policy

  # pin outbound webhooks to a single CIDR (admin scope when SIGNALCLAW_ADMIN_KEY is set)
  curl -X PUT http://localhost:7430/api/admin/webhooks/egress-policy \
    -H 'content-type: application/json' \
    -d '{"allow_private": false, "cidrs": ["203.0.113.0/24"]}'

  # a subscription pointed at a private destination is refused up front
  curl -i -X POST http://localhost:7430/api/webhooks \
    -H 'content-type: application/json' \
    -d '{"url":"http://169.254.169.254/latest/meta-data/","events":["entered"]}'
  # => 400 {"error":{"code":"private_destination","message":"resolved address 169.254.169.254 is in a blocked range ..."}}
  ```

- **Configurable data retention with on-demand sweep**. SOC2 CC6 and GDPR Article 5(1)(e) both want a documented data-minimisation control: how long does the platform keep operational data, who set the window, and when was it last enforced? SignalClaw now ships a per-deployment retention policy stored at `<data_dir>/retention.json` covering three classes of operational data: saved runs (`runs_days`), the authenticated audit log including the rotated `audit.jsonl.1` half (`audit_days`), and outbound webhook delivery attempts (`webhook_deliveries_days`). Zero on any field means retain forever, matching prior behaviour for fresh installs. The sweep is idempotent and is invoked three ways: explicitly via `POST /api/admin/retention/run`, opportunistically inside `listRuns`, `queryAudit`, and `listDeliveries` on a one-hour throttle so a long-running deployment converges without a cron, and implicitly after any `PUT /api/admin/retention` policy change. The policy update endpoint writes a before/after diff to the audit log with `reason: retention.policy.updated` so a security reviewer can prove the window did not silently shrink. Unparseable audit lines are retained (we never silently destroy data we cannot read). Subscriptions themselves are never deleted; only their delivery attempt history is pruned. The dashboard at `/settings/retention` exposes the policy with input validation (whole-number days, 0 to 3650), a confirm-gated Run sweep now button, and a Last sweep card that shows the timestamp and per-class purge counts from the most recent run. Covered by `tests/retention.test.mjs` (default is retain-forever, non-numeric clamps to zero, zero policy is a no-op, runs older than the window are removed and edge cases at the cutoff are kept, audit lines purge across both current and rotated files, webhook deliveries are pruned by `delivered_at`, last-sweep state persists, and `maybeAutoSweep` is throttled and short-circuits on a zero policy).

  Try it locally: `pnpm --filter signalclaw-web dev` then visit http://localhost:7430/settings/retention and
  ```bash
  # set: keep runs 90 days, audit 180 days, webhook deliveries 30 days
  curl -X PUT http://localhost:7430/api/admin/retention \
    -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" \
    -d '{"runs_days":90,"audit_days":180,"webhook_deliveries_days":30}'

  # trigger an immediate sweep
  curl -X POST http://localhost:7430/api/admin/retention/run \
    -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY"
  # => { "ran_at": "...", "counts": { "runs": 12, "audit": 803, "webhook_deliveries": 4 }, "policy": { ... } }
  ```

- **Per-API-key tenant isolation for webhook subscriptions**. Webhooks carry secrets and trigger downstream side effects, so cross-tenant leakage at the subscription layer is a procurement blocker. Every `WebhookSubscription` now carries an `owner_key_id` that is stamped from the calling API key's stable `StoredKey.id` at creation time and persisted to `<data_dir>/webhooks.json`. `GET /webhooks` returns only the caller's own rows, `DELETE /webhooks/{id}` returns `404` (not `403`) for a sibling tenant's id so existence does not leak, `POST /webhooks/fire/latest` fans out only to subscriptions the caller owns via a `_ScopedWebhookStore` adapter that still lets the deliverer persist last-status updates, `GET /webhooks/deliveries` filters log rows by visible subscription ids, and `POST /webhooks/deliveries/{attempt_id}/replay` rejects replay attempts whose underlying subscription the caller cannot see. Admin-role keys (user-managed `admin` scope, env-registry keys with `admin`, and the legacy operator-default `SIGNALCLAW_API_KEY`) see and act on every tenant's webhooks, matching the existing admin console expectation. Legacy rows that predate this field (`owner_key_id` is `None`) are visible only to admins, so a brand-new user key cannot inherit data created by the operator. Covered by `tests/test_webhooks_tenant_isolation.py` (Alice's webhook is invisible to Bob, Bob's `DELETE` and replay both 404 without leaking existence, admin can see and delete both, and Bob cannot list a delivery row whose subscription Alice owns).

  Try it locally: `make api` then
  ```bash
  # Alice's key sees only her own subscriptions
  curl http://localhost:7431/webhooks -H "x-api-key: $ALICE_KEY"

  # Bob trying to delete Alice's subscription gets 404, not 403
  curl -i -X DELETE http://localhost:7431/webhooks/$ALICE_SUB_ID \
    -H "x-api-key: $BOB_KEY"
  # => HTTP/1.1 404 Not Found
  ```

- **Per-API-key source IP allowlist (CIDR), enforced on every `/api/v1/*` route**. Enterprise security teams want defence in depth on top of the workspace-wide network policy: even if a key leaks, it should only authenticate from the customer's known service IPs (a backend ETL VPC, an office VPN, a Render egress range). SignalClaw now stores a per-key `ip_allowlist` (canonical CIDRs, IPv4 and IPv6, bare IPs stored as `/32` or `/128`, dedupe-on-write, capped at 64 entries) inside the existing keys file at `<data>/keys.json`. The check lives in the shared `v1Guard.enforceRateLimit` wrapper, so every existing v1 route picks it up without per-handler changes: a blocked request returns `403 {"error":{"code":"ip_not_allowed"}}` before any rate-limit token is consumed or any handler body runs, and is written to the audit log with `reason: ip_not_allowed:<source>` so operators can see which key tried what from where. IPv4-mapped IPv6 sources like `::ffff:203.0.113.5` arriving on a dual-stack socket are normalised so a plain IPv4 CIDR still matches. The new admin endpoints `GET /api/admin/keys/{id}/ip-allowlist` and `PUT /api/admin/keys/{id}/ip-allowlist` validate every entry at the boundary (a single bad CIDR rejects the whole update with `400 bad_cidr`), and the dashboard at `/settings/keys` exposes a per-key IP allowlist editor with the same lockout-aware copy as the workspace page. Empty list means "any source"; revoked keys cannot be edited. Covered by `tests/ipAllowlist.test.mjs` (CIDR canonicalisation and dedupe, max-entries cap, garbage rejection, IPv4 and IPv6 network match, IPv4-mapped IPv6 normalisation, `x-forwarded-for` leftmost extraction, cross-key isolation showing a blocked IP still passes on a different key with no allowlist, unknown source IP blocked, clearing the list reopens the key).

  Try it locally: `pnpm --filter signalclaw-web dev` then
  ```bash
  # pin a key to your office and a single bastion host
  curl -X PUT http://localhost:7430/api/admin/keys/$KEY_ID/ip-allowlist \
    -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" \
    -d '{"ip_allowlist":["203.0.113.0/24","198.51.100.7"]}'

  # a call from outside that range is now 403 before rate limiting
  curl -i http://localhost:7430/api/v1/runs \
    -H "Authorization: Bearer $KEY_SECRET" \
    -H "x-forwarded-for: 8.8.8.8"
  # => HTTP/1.1 403 Forbidden
  # => {"error":{"code":"ip_not_allowed","message":"source IP is not in this key's allowlist"}}

  # clear the allowlist (empty array = any source)
  curl -X PUT http://localhost:7430/api/admin/keys/$KEY_ID/ip-allowlist \
    -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" \
    -d '{"ip_allowlist":[]}'
  ```

- **Sandbox / dry-run mode on every mutating v1 endpoint**. Enterprise procurement reviewers want to exercise the API surface before they trust it with state, and SREs want a safe way to verify that an automation does the right thing without flipping a real alert or deleting a real run. Every mutating route under `/api/v1` now accepts `?dry_run=true` (also `1`/`yes`), an `X-Dry-Run: true` header, or a top-level `"dry_run": true` JSON body field. Wired across `POST /api/v1/runs`, `DELETE /api/v1/runs/{id}`, `POST /api/v1/alerts`, `DELETE /api/v1/alerts/{id}`, `POST /api/v1/alerts/check`, `POST /api/v1/watchlist`, `PATCH /api/v1/watchlist/{ticker}`, and `DELETE /api/v1/watchlist/{ticker}`. Dry-run requests run the same auth, scope, rate-limit, and input validation as a real call, then return `200` with `{ dry_run: true, would: { action, resource, id, preview } }` and an `X-Dry-Run: true` response header, without writing to any store. The audit log records each dry-run with `reason: "dry_run"` so security review can see who probed the API and what they would have done. For `POST /api/v1/alerts/check` the evaluator runs end to end but `last_fired_at` and the history ring are not persisted, so a buyer can preview which alerts would fire against any supplied price snapshot without burning the cooldown gate. Covered by `tests/dryRun.test.mjs` (query string, header, and body opt-in detection; `false` overrides body; `runCheck({ dryRun: true })` does not persist `last_fired_at` while the real call does).

  Try it locally: `pnpm --filter signalclaw-web dev` then
  ```bash
  curl -X POST http://localhost:7430/api/v1/watchlist?dry_run=true \
    -H "Authorization: Bearer $SIGNALCLAW_API_KEY" \
    -H "content-type: application/json" \
    -d '{"ticker":"NVDA","note":"earnings setup"}'
  # => 200 { "dry_run": true, "would": { "action": "create", "resource": "watchlist_entry", "id": "NVDA", ... } }
  ```

- **Per-key monthly quotas with billing plans and standard rate-limit headers**. Enterprise procurement asks two questions on every call: how do you cap a customer's usage, and how do we see what they consumed this month for billing. SignalClaw now ships a plan catalogue (`free`, `pro`, `enterprise`; override with `SIGNALCLAW_PLANS_JSON`) and a `QuotaMiddleware` that bills every authenticated request against the calling key's plan. Counts live in `<data_dir>/quotas.json` keyed by `(key_id, YYYY-MM)`; the key id is the stable id from the user-managed store so usage survives secret rotation, and env-configured keys get a deterministic `env:<sha8>` bucket. When a key crosses its monthly ceiling the middleware returns `429` with `Retry-After` set to the seconds until 00:00 UTC on the first of the next month, plus the standard envelope `X-RateLimit-Scope: monthly`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Successful responses carry the same headers reflecting the post-increment state so a customer dashboard can render "412 of 10,000 calls this month" without a separate probe; unlimited plans report `X-RateLimit-Limit: 0` and `X-RateLimit-Remaining: unlimited` (GitHub's convention). Anonymous traffic, health, readiness, metrics, and docs are exempt. New admin endpoints `GET /admin/plans`, `PUT /admin/keys/{id}/plan`, `GET /admin/usage`, and `GET /admin/usage/{id}` are gated by `admin` scope plus MFA and audited via the existing `AuditMiddleware`. Covered by `tests/test_quotas.py` (standard headers on success, no headers for anonymous traffic, monthly ceiling returns 429 with Retry-After, plan upgrade lifts the cap on the next call without restart, per-key usage isolation, plan catalogue and default plan are visible).

  Try it locally: `make api` then
  ```bash
  # list plans
  curl http://localhost:7431/admin/plans \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" -H "x-mfa-code: 123456"

  # upgrade a key to the pro plan
  curl -X PUT http://localhost:7431/admin/keys/$KEY_ID/plan \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" -H "x-mfa-code: 123456" \
    -H "content-type: application/json" -d '{"plan":"pro"}'

  # see this month's usage for every key
  curl http://localhost:7431/admin/usage \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" -H "x-mfa-code: 123456"
  ```

- **Workspace-level IP allowlist (global network policy)**. Enterprise security teams routinely require the ability to restrict the API and dashboard to a known set of office, VPN, or bastion CIDRs as a precondition to signing. SignalClaw now ships a workspace-wide allowlist enforced by `GlobalIPAllowlistMiddleware` ahead of authentication, audit, and rate limiting, so off-network callers are dropped before any handler or store runs. The policy is JSON-backed under `<data_dir>/network_policy.json`, defaults to disabled so existing deployments keep working unchanged, and refuses `enabled=true` with an empty CIDR list to prevent self-lockout. CIDRs are validated with the stdlib `ipaddress` module; bare IPs are accepted and promoted to `/32` or `/128`. Health, readiness, metrics, and docs paths stay exempt so external monitors keep working, and loopback (`127.0.0.1`, `::1`) is always allowed so an operator on the box itself cannot be locked out. The admin endpoints `GET /admin/network-policy` and `PUT /admin/network-policy` are gated by the `admin` scope plus MFA and audited via the existing `AuditMiddleware`. The dashboard page at `/settings/network` adds a toggle, an add/remove CIDR list with a lockout warning when enforcement would activate without any CIDRs, and a save action that surfaces the API's structured 400 on bad input. Covered by `tests/test_network_policy.py` (CIDR normalisation, refusal to enable with empty list, cap at `MAX_CIDRS`, disabled policy passes through, enabled policy blocks a non-allowlisted IP with 403, on-network IP passes, health and metrics exempt, admin endpoints update with validation).

  Try it locally: `make api` then
  ```bash
  # inspect current policy (default: disabled)
  curl http://localhost:7431/admin/network-policy \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" -H "x-mfa-code: 123456"

  # restrict to office + VPN
  curl -X PUT http://localhost:7431/admin/network-policy \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" -H "x-mfa-code: 123456" \
    -H "content-type: application/json" \
    -d '{"enabled":true,"cidrs":["203.0.113.0/24","10.0.0.0/8"]}'
  ```
  Open `http://localhost:3000/settings/network` to manage CIDRs from the dashboard.

- **Invite links and seat management for onboarding teammates without sharing secrets**. An owner or admin mints a one-time invite at `/settings/invites` (or `POST /api/admin/invites`) with a label, scopes (`read`, `trade`), seat count, and optional expiry up to 90 days. The redemption URL `/invite/{token}` shows the invitee exactly what they are about to accept (label + scopes + expiry, never the creator id or accept log), and on accept a fresh API key is minted and revealed exactly once. `admin` is never grantable through an invite, so a leaked or social-engineered link cannot escalate. Seat usage is workspace-wide: set `SIGNALCLAW_SEAT_LIMIT=N` to cap the number of active (non-revoked) keys, and both `POST /api/admin/keys` and `POST /api/invites/{token}/accept` return `409 seat_limit` once full. Revoking a key frees the seat immediately. Invites are stored append-only with `used_count`, `accepted_by` (key id + accept time + sha256(IP)), and a status of `pending` / `exhausted` / `expired` / `revoked`; `DELETE /api/admin/invites/{token}` revokes a pending link. Every redemption, lookup, and admin mutation is captured by the existing audit log. The redemption UI handles loading, error, empty, and the four terminal states responsively. Covered by `web/tests/invites.test.mjs` (single-use exhaustion, expired, revoked, race-loser, redeemer view never leaks creator id or accept log, seat limit denies further mints and revoking frees a seat).

  Try it locally: `cd web && npm run dev` then
  ```bash
  # As admin: create a 7-day, single-seat invite with read scope only.
  curl -X POST http://localhost:7430/api/admin/invites \
    -H "content-type: application/json" \
    -d '{"label":"alice@acme.com","scopes":["read"],"max_uses":1,"expires_in_seconds":604800}'
  # => { "token":"inv_...", "status":"pending", ... }

  # As the invitee: redeem the link (no admin key required).
  curl -X POST http://localhost:7430/api/invites/inv_.../accept \
    -H "content-type: application/json" -d '{"label":"alice-laptop"}'
  # => { "id":"...","scopes":["read"],"secret":"sc_live_..." }   # shown once
  ```
  Cap seats per workspace by exporting `SIGNALCLAW_SEAT_LIMIT=10` before starting the web app.

- **RBAC roles on every API key (owner, admin, member, viewer)**. SignalClaw API keys now carry an explicit role that caps what the key can do, layered on top of the existing scope system. `owner` and `admin` carry the `admin` scope (manage keys, sessions, audit, MFA, GDPR). `member` carries `read` + `trade`. `viewer` is read only and cannot mutate anything, even if the request lists the `trade` scope. The role is the chokepoint: on every request, the resolved key's stored scopes are intersected with the role's allow list, so a downgrade from `admin` to `viewer` immediately revokes the admin scope on the next request without touching the secret. The dashboard at `/settings/keys` adds a role picker on create and a per-key Role button to change it later, both gated by `admin` scope plus MFA. The new endpoint is `PUT /admin/keys/{id}/role` with body `{"role":"owner|admin|member|viewer"}`; unknown roles return 400 and unknown keys return 404. Covered by `tests/test_api_keys_rbac.py` (viewer cannot write even when trade was requested, member cannot reach admin routes, role downgrade revokes admin on next request, unknown roles rejected at create and update). Existing keys that predate this field default to `member` so nothing breaks on upgrade.

  Try it locally: `make api` then
  ```bash
  curl -X POST http://localhost:7431/admin/keys \
    -H "x-api-key: $SIGNALCLAW_API_KEY" -H "content-type: application/json" \
    -d '{"label":"analyst-readonly","role":"viewer"}'
  # => 200 {"role":"viewer","effective_scopes":["read"],"secret":"sck_..."}
  ```
  Open `http://localhost:3000/settings/keys` to see the role picker and per-key role badge.

- **SSRF guard on outbound webhook destinations**. Enterprise security review rejects any product that lets a user register an arbitrary webhook URL and have the server POST to it without validation. SignalClaw now refuses webhook destinations that resolve to loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16` including the EC2/GCP metadata IP, `fe80::/10`), RFC1918 private space, multicast, or reserved ranges. The check runs at subscribe time in `POST /webhooks` so bad rows never persist, and again inside `_default_http` on every delivery attempt (including retries and byte-for-byte replays) so a hostname whose A record flips to internal space after subscribe is still blocked. URLs with embedded credentials (`https://user:pass@host/...`) and non-http(s) schemes are rejected. Operators can pin destinations to a fixed set via `SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST=hook.example.com,events.example.com` (suffix match against subdomains, so `a.hook.example.com` matches `hook.example.com`); when set, only listed hosts are allowed. `SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE=1` opts the guard out for dev fixtures and is the only thing the test suite uses to keep the existing `*.test` fakes working. Covered by `tests/test_webhooks_ssrf.py` (loopback, EC2 metadata IP, RFC1918, credentialed URLs, non-http schemes, unresolvable hosts, allowlist allow + deny, delivery-time refusal via `_default_http`, and policy parsing).

  Try it locally: `make api` then
  ```bash
  curl -X POST http://localhost:7431/webhooks \
    -H "x-api-key: $SIGNALCLAW_API_KEY" -H "content-type: application/json" \
    -d '{"url":"http://169.254.169.254/latest/meta-data/"}'
  # => 400 {"detail":"refusing webhook to non-public ip 169.254.169.254"}
  ```

- **Force-logout enforcement (revoked sessions actually stay revoked)**. Until now the admin "Revoke session" button only cleared the ledger row, so the same client recreated the entry on its next request. SignalClaw now keeps a separate `RevocationStore` and consults it inside `SessionTrackingMiddleware` BEFORE the request reaches a route. `DELETE /admin/sessions/{id}` places a session-scope block on the matching `(key_id, source_ip, user_agent)` fingerprint, and the next request from that exact client is rejected with `HTTP 401 {"detail":"session revoked"}` plus an `x-session-revoked: 1` header. `POST /admin/sessions/revoke-key/{key_id}` upgrades the block to key scope so every UA / IP using that key is rejected, including ones the operator has never seen before. `POST /admin/sessions/revoke-all` places key-scope blocks on every key currently in the ledger EXCEPT the caller's own key, so an operator running an incident response cannot lock themselves out mid-revoke. `POST /admin/sessions/{id}/restore` and `POST /admin/sessions/restore-key/{key_id}` lift a previously placed block. Revocations auto-expire after `SIGNALCLAW_REVOCATION_TTL_SECONDS` (default 30 days) so the file stays bounded and a long-lived block never outlives the underlying key rotation. The `/admin/sessions/*` recovery routes are exempt from the revocation gate so an operator who accidentally revokes their own session can still reach the restore endpoint. Covered by `tests/test_session_revocation.py` (revoke blocks the same client and a different UA on the same key is unaffected, revoke-key blocks every UA including unseen ones, revoke-all exempts the caller and blocks everyone else, the admin recovery surface is reachable after self-revoke, restore lifts the block).

  Try it locally: `make api` then
  ```bash
  # 1. Probe with a reader key to register a session row.
  curl http://localhost:7431/watchlist -H "x-api-key: $READER_KEY"
  # 2. Find the session id.
  SID=$(curl -s http://localhost:7431/admin/sessions \
        -H "x-api-key: $ADMIN_KEY" -H "x-mfa-code: 123456" \
        | jq -r '.sessions[0].id')
  # 3. Force-logout that session.
  curl -X DELETE http://localhost:7431/admin/sessions/$SID \
       -H "x-api-key: $ADMIN_KEY" -H "x-mfa-code: 123456"
  # 4. Same reader key is now blocked.
  curl -i http://localhost:7431/watchlist -H "x-api-key: $READER_KEY"
  # HTTP/1.1 401 Unauthorized
  # x-session-revoked: 1
  # {"detail":"session revoked","reason":"admin_revoke","scope":"session",...}
  ```

- **Active sessions admin console (visibility + force-revoke)**. SignalClaw now records every authenticated request as a session row keyed by `(api_key, source_ip, user_agent)` and exposes the live list at `GET /admin/sessions`. An operator can see which keys are in use, from which IPs, with which clients, when each session was first seen, when it was last seen, and how many requests it has served. Suspicious row? `DELETE /admin/sessions/{id}` drops just that row. Suspected compromise of one key? `POST /admin/sessions/revoke-key/{key_id}` clears every row tied to it. Suspected platform-wide compromise? `POST /admin/sessions/revoke-all` resets the entire ledger. The session store auto-prunes rows older than `SIGNALCLAW_SESSION_TTL_SECONDS` (default 14 days) so it stays bounded without operator intervention. All four endpoints require the `admin` scope plus MFA and are written to the tamper-evident audit log. Covered by `tests/test_sessions_admin.py` (tracking creates rows, non-admin gets 403, revoke removes one row, revoke-all clears the ledger without invalidating the underlying credential, missing session returns 404).

  Try it locally: `make api` then
  ```bash
  curl http://localhost:7431/admin/sessions \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "x-mfa-code: 123456"
  ```

- **Enterprise hygiene paper trail**. Added `SECURITY.md` (reporting policy, response SLAs, scope), `CODEOWNERS` (security-sensitive paths require explicit owner review), `.github/dependabot.yml` (weekly pip + npm + actions updates, grouped minor/patch), and `docs/threat-model.md` (STRIDE analysis covering audit-log tampering, key spoofing, DoS shedding, and privilege escalation paths).

- **Sandbox / dry-run mode on every mutating endpoint**. Any POST, PUT, PATCH, or DELETE against the SignalClaw API accepts `?dry_run=true` (or an `X-Dry-Run: 1` header) and short-circuits with HTTP 202 plus a structured envelope describing what *would* have happened. No stores are written, no webhooks fire, no notifier traffic is queued. The probe still has to clear scope, MFA, rate-limit, and IP-allowlist checks (those middlewares run outside the dry-run guard), so a buyer can validate end-to-end that their key has the right permission to delete a record without deleting one. Every dry-run call is persisted to the audit log with `action="dry_run"` and `extra.dry_run=true` so SOC2 reviewers can tell probe traffic apart from real mutations. Covered by `tests/test_dry_run.py` (short-circuit on POST and DELETE, header parity with query param, audit row recorded, scope still enforced, GET unaffected).

  ```bash
  # Probe a destructive call without writing state.
  curl -i -X POST 'http://localhost:7431/watchlist?ticker=AAPL&dry_run=true' \
    -H "x-api-key: $SIGNALCLAW_API_KEY"
  # HTTP/1.1 202 Accepted
  # x-dry-run: true
  # {"dry_run":true,"would_execute":{"method":"POST","path":"/watchlist",...},"note":"Sandbox mode: no state changed. Remove dry_run=true to apply this request."}
  ```

- **TOTP MFA gate on every admin endpoint**. SignalClaw API keys can now enroll a second factor so that admin actions (audit log access, key minting / rotation / revocation, GDPR export, GDPR delete, MFA disable itself) require both the key and a fresh 6-digit code. Enrollment is per key, scoped by SHA-256 of the secret so the secret itself is never written to disk, and the code window enforces RFC 6238 with a one-step skew and explicit replay protection (the most recently accepted step is recorded and re-presenting the same code returns 401). An enterprise deployment can set `SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN=1` to block any unenrolled key from admin routes at all. The dashboard at `/settings/security` runs the enroll flow (QR code plus copyable base32 secret plus 6-digit confirm) and stores the active code in tab-local sessionStorage so existing pages (`/settings/audit`, `/settings/keys`) keep working without per-page changes. Covered by `tests/test_mfa.py` (admin works before enrollment, admin requires `x-mfa-code` after enrollment, replayed code rejected, fresh code accepted).

  ```bash
  # 1) enroll the calling key
  curl -X POST http://localhost:7431/mfa/enroll \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" -d '{"label":"laptop"}'

  # 2) confirm with the first 6-digit code from your authenticator
  curl -X POST http://localhost:7431/mfa/confirm \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" -d '{"code":"123456"}'

  # 3) every admin call now needs a fresh code
  curl http://localhost:7431/audit \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "x-mfa-code: 654321"
  ```

  Try it locally: `make api` then open `http://localhost:3000/settings/security`.
- **API key hard expiry (SOC2-style credential lifetime cap)**. Every user-managed API key can now carry an optional `expires_at` deadline so credentials cannot live forever. The dashboard create form at `/settings/keys` defaults new keys to 90 days (7 / 30 / 90 / 180 / 365 day presets, plus an explicit "Never" with a warning), and existing keys can have their expiry set or cleared via `PUT /admin/keys/{id}/expiry`. Expired keys are rejected at auth time with a 401 even if their scopes are still valid; the in-memory index drops the dead hash on the next request so a stale cache cannot keep a credential alive past its deadline. Hard-cap is one year so a forgotten dashboard value cannot mint a multi-decade key, and the helper fails closed on garbled timestamps so a corrupted JSON file cannot extend a credential by accident. Covered by `tests/test_api_keys_expiry.py` (creation with TTL, force-expire on disk + 401 on reuse, bounds validation, fail-closed helper).

  ```bash
  # mint a 30-day read key
  curl -X POST http://localhost:7431/admin/keys \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" \
    -d '{"label":"laptop","scopes":["read"],"expires_in_seconds":2592000}'

  # set / clear expiry on an existing key (null clears it)
  curl -X PUT http://localhost:7431/admin/keys/<key_id>/expiry \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H "content-type: application/json" \
    -d '{"expires_in_seconds":7776000}'
  ```

  Try it locally: `make api` then open `http://localhost:3000/settings/keys` and create a key with the new "Expires" selector.
- **Prometheus metrics, k8s probes, and request-id tracing on the dashboard**. The Next.js control plane now ships first-class observability so an SRE team can wire it into their stack without writing glue. Three new endpoints are exposed: `GET /healthz` is a liveness probe that returns 200 plus version and process uptime without touching any dependency, `GET /readyz` runs real readiness checks (currently `.data` writability, since the audit log and key store live there) and returns 503 with the failing check name when something is wrong, and `GET /metrics` renders Prometheus text exposition (process resident memory and heap, in-flight requests gauge, per-route request counter, and a duration histogram with 11 standard buckets). Label cardinality is bounded by design: `method` x `status_class` (`2xx`/`3xx`/`4xx`/`5xx`) x `route_class` (`api_v1`/`api_admin`/`api_other`/`page`/`asset`/`health`/`metrics`), so the series count cannot blow up from user-generated ids in URLs. An edge middleware mints `X-Request-Id` on every inbound request (or echoes an incoming one that looks safe), propagates it into the route handler, and sets it on the response. The same id is now recorded on every audit log entry, so an operator can grep the audit log by request id and stitch dashboard traffic to upstream traces end to end.

  ```bash
  # Liveness, readiness, and a Prometheus scrape
  curl -s http://localhost:7430/healthz | jq .
  curl -s http://localhost:7430/readyz  | jq .
  curl -s http://localhost:7430/metrics | head -20

  # Propagate your own request id, then find it in the audit log
  curl -s -H "x-request-id: req_demo_42" \
       -H "authorization: Bearer $SIGNALCLAW_KEY" \
       http://localhost:7430/api/v1/whoami -D -
  grep req_demo_42 web/.data/audit.jsonl
  ```

  Covered by `web/tests/observability.test.mjs` (route classifier bounds, status-class bucketing, in-flight gauge, histogram cumulation including `+Inf`, audit `request_id` capture and absence). The Python ingest service already exposes the same `/healthz`, `/readyz`, and `/metrics` shape, so a single Prometheus scrape config covers both planes.

- **API key rotation with grace window**. Rotate any user-managed API key in place without downtime. The new endpoint mints a fresh secret on the same key id (scopes, label, rate limit, and IP allowlist all preserved) and optionally keeps the previous secret valid for a bounded overlap so live integrations can roll over before the old credential stops working. The plaintext secret is returned exactly once and never logged; the predecessor hash is stored only for the grace window and dropped on the next index reload after it expires. Grace is clamped to 7 days so a forgotten rotation cannot turn into a long-lived dual credential. Surfaced in the dashboard at `/settings/keys` (the existing "Rotate" button now prompts for grace seconds) and via the admin API. The previous hash is never returned by `GET /admin/keys`, so an admin compromise cannot exfiltrate the still-valid old secret.

  ```bash
  # immediate cutover (default): old secret stops working right away
  curl -X POST http://localhost:7431/admin/keys/<key_id>/rotate \
    -H 'x-api-key: <admin-key>' \
    -H 'content-type: application/json' \
    -d '{"grace_seconds": 0}'

  # graceful: keep the old secret valid for 5 minutes during cutover
  curl -X POST http://localhost:7431/admin/keys/<key_id>/rotate \
    -H 'x-api-key: <admin-key>' \
    -H 'content-type: application/json' \
    -d '{"grace_seconds": 300}'
  ```

  Audited via the standard middleware (actor key id, route, status, client IP hash). Covered by `tests/test_api_keys_rotate.py` including a real wall-clock grace expiry. The k8s-standard `/healthz` and `/readyz` aliases for the existing health and readiness probes ship in the same change.

- **Per-key rate limits with standard 429 headers**. Every `/api/v1/*` call is now metered against a sliding 60-second window per API key. Allowed requests carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Window`. Over-cap requests get an HTTP 429 with `Retry-After` and a structured body (`code: "rate_limited"`, `limit`, `retry_after`), and the throttle is itself written to the audit log so operators can see who tripped it. The default cap is 60 req/min, configurable via `SIGNALCLAW_RATE_LIMIT_PER_MIN`. Each key can also be raised or lowered individually from the dashboard at `/settings/keys` (the new "Rate limit" button on each row), or via the admin API:

  ```bash
  # UI
  open http://localhost:7430/settings/keys

  # Inspect the current cap for a key
  curl -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    http://localhost:7430/api/admin/keys/<key_id>/rate-limit

  # Override to 600 req/min for one key
  curl -X PUT -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"limit": 600}' \
    http://localhost:7430/api/admin/keys/<key_id>/rate-limit

  # Clear the override (back to the global default)
  curl -X PUT -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"limit": null}' \
    http://localhost:7430/api/admin/keys/<key_id>/rate-limit
  ```

  Counters live in `web/.data/ratelimits.json` (atomic JSON writes). Wired through `lib/rateLimitStore.ts` + `lib/v1Guard.ts` so every public route shares the same enforcement path. Unit-tested for window roll-over, override isolation across keys, and header shape.

- **Per-key IP allowlist**. Restrict any user-managed API key to a fixed set of source IPs or CIDR blocks. Mint or update an allowlist in the dashboard at `/settings/keys`, or via the API. Requests from outside the list are rejected with HTTP 403 and a structured payload (`detail`, `client_ip`, `key_id`, `allowlist`) so SIEM rules can pivot on key id without parsing prose. IPv4 and IPv6 both supported; bare IPs become host networks (`/32` or `/128`); up to 64 entries per key; fail-closed when the client IP is missing or unparseable; honours `SIGNALCLAW_TRUST_FORWARDED` + `SIGNALCLAW_TRUSTED_PROXIES` so the same proxy-trust knobs that gate the rate limiter gate this check too. Keys with an empty allowlist are unaffected, so existing deployments keep working unchanged.

  ```bash
  # UI
  open http://localhost:7430/settings/keys

  # Restrict a key to your office and a single VPC CIDR
  curl -X PUT http://localhost:7430/api/admin/keys/<key_id>/ip-allowlist \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"ip_allowlist": ["203.0.113.0/24", "10.0.0.0/8"]}'

  # Clear the allowlist (empty list = unrestricted)
  curl -X PUT http://localhost:7430/api/admin/keys/<key_id>/ip-allowlist \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"ip_allowlist": []}'
  ```

- **Audit log on every authenticated route**. Every call into `/api/v1/*` and `/api/admin/keys*` now appends an immutable record to `web/.data/audit.jsonl`: the calling key id + label + scopes, the route, method, status, a per-key SHA-256 hash of the caller IP (never the raw IP), a reason on failures (`unauthorized`, `forbidden:trade-required`, `forbidden:admin-required`, …), and a small JSON details blob capped at 2 KiB. Plaintext secrets never touch the log. Browse and filter the log in the UI at `/settings/audit`, or hit it programmatically:

  ```bash
  # UI
  open http://localhost:7430/settings/audit

  # Public API (admin scope required)
  curl -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    'http://localhost:7430/api/v1/audit?ok=0&limit=50'

  # Filter by key id, method, route substring, since timestamp
  curl -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    'http://localhost:7430/api/v1/audit?key_id=<id>&method=POST&route=/runs&since=2026-01-01T00:00:00Z'
  ```

  Reading the audit log is itself audited. The file auto-rotates at 50k entries into `audit.jsonl.1`. Queries are validated (string length caps, ISO 8601 on `since`) and capped at 1000 events per request. Backed by `lib/auditStore.ts` with serialized appends and a salted IP hash that differs across keys, so the same caller produces a different `ip_hash` per key.

- **Bulk actions in run history**. Select runs on `/history` with row checkboxes (or the page-level select-all), then pin, unpin, tag, untag, export as CSV/JSON, or delete in one step. Backed by a single `POST /api/runs/bulk` endpoint that takes `{ ids, action, tags?, format? }` and returns `{ matched, affected, ids }`. Capped at 200 ids per request, idempotent for pin/unpin/tag ops.

### Try bulk actions

```bash
# UI
open http://localhost:7430/history

# Tag two runs at once
curl -sS -X POST http://localhost:7430/api/runs/bulk \
  -H 'content-type: application/json' \
  -d '{"ids":["<id1>","<id2>"],"action":"add_tags","tags":["review"]}'

# Export a hand-picked selection as CSV
curl -sS -X POST http://localhost:7430/api/runs/bulk \
  -H 'content-type: application/json' \
  -d '{"ids":["<id1>","<id2>"],"action":"export","format":"csv"}' -o selected.csv

# Delete a batch
curl -sS -X POST http://localhost:7430/api/runs/bulk \
  -H 'content-type: application/json' \
  -d '{"ids":["<id1>","<id2>"],"action":"delete"}'
```

- **Bulk export, single-run export, usage meter, and delete in the public API**. `GET /api/v1/runs/export?format=csv|json` streams every matching run as a downloadable file (same `q`, `ticker`, `regime`, `limit` filters as `GET /api/v1/runs`). `GET /api/v1/runs/<id>/export?format=csv|json` exports one run. `GET /api/v1/usage` returns the same free-tier meter shown in the UI so integrations can warn users before they hit the cap. `DELETE /api/v1/runs/<id>` removes a saved run (trade scope). The keys page on `/settings/keys` now ships these curl examples next to the existing ones.
- **Scheduled watches** at `/watches`: pick a ticker, lookback, and cadence (hourly through weekly). Each tick classifies the regime, saves a tagged run to history, and raises an activity event on regime change. Wire any cron (Vercel scheduled function, GitHub Actions, your own box) to `POST /api/watches/run`; protect it with `WATCH_CRON_TOKEN` when set. Watches persist to `web/.data/watches.json` with atomic writes, capped at 50, deduped on (ticker, lookback, cadence). Auto-saved runs land under the `watch` tag in `/history`.
- **Pin runs** to your home rail. Click the pin on any saved run or share page (`/r/<id>`) to keep it one click away. The `/history` page gets a Pinned-only filter and a horizontal Pinned rail at the top, so your starred work shows up the moment you land. Pinned state is exposed on `/api/runs` and `/api/v1/runs` via `?pinned=1`. Toggle by `PATCH /api/runs/<id>` with `{"pinned": true|false}`.

### Try watches

```bash
# UI
open http://localhost:7430/watches

# Create a daily SPY watch
curl -sS -X POST http://localhost:7430/api/watches \
  -H 'content-type: application/json' \
  -d '{"ticker":"SPY","lookback_days":180,"cadence_hours":24,"label":"SPY daily"}'

# Tick the scheduler (cron entrypoint)
curl -sS -X POST http://localhost:7430/api/watches/run \
  -H "x-cron-token: $WATCH_CRON_TOKEN"

# Peek how many are due without running
curl -sS http://localhost:7430/api/watches/run \
  -H "x-cron-token: $WATCH_CRON_TOKEN"
```

### Try pinning

```bash
# Boot the web app
cd web && pnpm install && pnpm dev   # http://localhost:7430

# Pin a saved run
curl -X PATCH http://localhost:7430/api/runs/<RUN_ID> \
  -H 'content-type: application/json' \
  -d '{"pinned": true}'

# List only pinned runs (UI also exposes a Pinned filter on /history)
curl 'http://localhost:7430/api/runs?pinned=1&limit=8'

# Same filter on the Bearer-auth public API
curl -H "Authorization: Bearer $SIGNALCLAW_KEY" \
  'http://localhost:7430/api/v1/runs?pinned=1'
```

- **Comments on shared runs** at `/r/<id>`: anyone with a share link can leave a public comment (display name optional, 1000 char body, 3-per-minute per IP rate limit, 500 per run hard cap). Comments persist to `web/.data/comments.json` with atomic writes and SHA-256 hashed IPs (never exposed). The run owner (anyone holding the local API key, or an admin-scoped key when `SIGNALCLAW_ADMIN_KEY` is set) can delete any comment in-place from the share page. Backed by `GET/POST /api/runs/<id>/comments` and `DELETE /api/runs/<id>/comments/<cid>`.
- **Watchlist in the public API** under `/api/v1/watchlist`: list, add, update note, and remove tracked tickers from the same Bearer-key surface. Read scope can list, trade scope can mutate. Fully documented at `/docs` with copy-paste curl. Capped at 100 tickers per install.
- **Alerts in the public API** under `/api/v1/alerts`: list, arm, and disarm price or percent alerts with the same Bearer key already used for `/api/v1/runs`. `POST /api/v1/alerts/check` evaluates every armed alert against caller-supplied prices, returns the hits, and writes them to the alert history and activity feed. Read scope can list, trade scope can mutate.
- **Digest subscriptions** at `/digest`: subscribe any webhook URL (Slack incoming, Discord, n8n, Zapier, custom) to a daily or weekly SignalClaw activity digest. Real outbound HTTP POST signed with HMAC-SHA256 in `x-signalclaw-signature`, one automatic retry on network errors and 5xx, per-subscription delivery log with status, attempt, and byte count. Schedule by pinging `POST /api/digest/cron` (optionally protected by `DIGEST_CRON_TOKEN`) from cron, Vercel scheduled functions, or any pinger. Pause, resume, rotate the secret, and trigger a one-off send from the UI.
- **Alerts, end to end** at `/alerts`: arm price-above / price-below / percent-change rules with cooldown windows, run `POST /api/alerts/check` to evaluate them against live or supplied prices, and browse the paginated fire history filtered by ticker. Records land in `web/.data/alerts.json` with atomic writes, and every fire posts to the activity feed.
- **Activity digest** at `/digest`: rolling summary of saved runs, webhook deliveries, batches, and alerts over a selectable window (1 / 3 / 7 / 14 / 30 / 90 days). Renders text + HTML previews of what the email digest will contain. Backed by `GET /api/digest/preview?days=N&format=json|text|html`.
- **Compare runs** at `/compare`: pick any two saved regime runs and overlay their normalized price series, regime mix, and window return. Backed by `GET /api/runs/compare?a=ID&b=ID`.

### Try it

```bash
# 1. Boot the web app
cd web && npm run dev

# 2. Save a run from /demo, copy its id from the URL after "/r/"
#    (or hit POST /api/runs from the existing curl examples below).

# 3. Post a public comment on the shared run
curl -sS -X POST http://localhost:7430/api/runs/<RUN_ID>/comments \
  -H 'content-type: application/json' \
  -d '{"author":"alice","body":"agree, chop is dominant here"}'

# 4. List comments
curl -sS http://localhost:7430/api/runs/<RUN_ID>/comments

# 5. Owner-only delete (omit auth in local single-user mode, or pass an admin key)
curl -sS -X DELETE http://localhost:7430/api/runs/<RUN_ID>/comments/<COMMENT_ID> \
  -H 'authorization: Bearer <ADMIN_KEY>'
```

Live UI: http://localhost:7430/r/<RUN_ID>

### Try it

```bash
# 1. Boot the web app
cd web && npm run dev   # http://localhost:7430/digest

# 2. Pull the JSON digest for the last 7 days
curl -s 'http://localhost:7430/api/digest/preview?days=7' | jq '.headline, .stats'

# 3. Or grab a renderable HTML email body
curl -s 'http://localhost:7430/api/digest/preview?days=7&format=html' > digest.html

# 4. Subscribe a webhook to the digest, then fire one immediately
curl -s -XPOST http://localhost:7430/api/digest/subscriptions \
  -H 'content-type: application/json' \
  -d '{"url":"https://hooks.slack.com/services/T000/B000/XXX","label":"team","cadence":"weekly","format":"slack"}'
curl -s 'http://localhost:7430/api/digest/subscriptions' | jq '.subscriptions[0].id' \
  | xargs -I{} curl -s -XPOST http://localhost:7430/api/digest/subscriptions/{}/deliver | jq '.ok,.status,.attempt'
curl -s 'http://localhost:7430/api/digest/deliveries?limit=5' | jq '.deliveries'

# 6. Manage alerts from the API (needs a trade-scope key minted at /settings/keys)
curl -s -XPOST http://localhost:7430/api/v1/alerts \
  -H 'authorization: Bearer sc_live_YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","condition":"price_above","value":150,"cooldown_hours":6}'
curl -s -H 'authorization: Bearer sc_live_YOUR_KEY' http://localhost:7430/api/v1/alerts | jq '.alerts'
curl -s -XPOST http://localhost:7430/api/v1/alerts/check \
  -H 'authorization: Bearer sc_live_YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"prices":{"NVDA":152.4}}' | jq '.hits'

# 7. Manage the watchlist from the API (read scope lists, trade scope mutates)
curl -s -H 'authorization: Bearer sc_live_YOUR_KEY' http://localhost:7430/api/v1/watchlist | jq '.entries'
curl -s -XPOST http://localhost:7430/api/v1/watchlist \
  -H 'authorization: Bearer sc_live_YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","note":"breakout watch"}'
curl -s -XPATCH http://localhost:7430/api/v1/watchlist/NVDA \
  -H 'authorization: Bearer sc_live_YOUR_KEY' \
  -H 'content-type: application/json' \
  -d '{"note":"earnings on the 24th"}'
curl -s -XDELETE http://localhost:7430/api/v1/watchlist/NVDA \
  -H 'authorization: Bearer sc_live_YOUR_KEY'

# 5. Arm an alert and fire a check against a supplied price
curl -s -XPOST http://localhost:7430/api/alerts \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","condition":"price_above","value":100,"cooldown_hours":1}'
curl -s -XPOST http://localhost:7430/api/alerts/check \
  -H 'content-type: application/json' \
  -d '{"prices":{"NVDA":150}}' | jq '.hits'
curl -s 'http://localhost:7430/api/alerts/history?limit=10' | jq '.events'
```


## What it does

Tracks a watchlist, ingests OHLCV via yfinance, generates daily picks from a feature pipeline (technical, sentiment, news events), and writes a dated report. Books trades into a local portfolio and produces P&L, drawdown, sector concentration, tax lots (FIFO/LIFO/HIFO with wash-sale window), and FX-converted views. Runs walk-forward parameter sweeps over rule-based strategies and child-order execution simulations under TWAP, VWAP, and POV schedules. Classifies market regime (bull / chop / bear / crash) to gate sizing. Manages alerts, bracket plans, scaling plans, stop rules, and a notifier with dead-letter queue (Telegram / Discord / Slack / webhooks).

## Features

- Watchlist + daily picks with archived report history and diffs
- Portfolio: trades, snapshot, attribution, sector concentration, drawdown tracker, tax report
- Risk: pretrade check, position sizing (equity / risk-per-trade / max-pct), correlation matrix, diversification scoring
- Walk-forward optimizer for SMA-crossover + RSI strategy (grid + train/test folds, OOS Sharpe / return / MDD)
- Execution simulator: TWAP, VWAP, POV with per-bar slippage and participation caps
- Regime detector over realized vol, trend slope, drawdown; emits a risk-scale multiplier
- Brackets (entry / stop / target with fill, close, cancel, stats)
- Stop rules engine + scaling plans (evaluate / cancel)
- Alerts with cooldown, manual or scheduled checks
- News events store + event study endpoint
- Rotation scoring, conviction journal, anomaly / data-quality reports
- FX rates + multi-currency trade view
- Notifier with DLQ, replay, and test endpoint
- Webhook subscriptions (events, ticker filter, HMAC secret)
- Watchlist at `/watchlist`: add up to 100 tickers (AAPL, BRK.B, ETH-USD), attach a short note, edit notes inline, export the full list as CSV, jump straight to per-ticker views. Backed by `GET/POST /api/watchlist` and `DELETE/PATCH /api/watchlist/<ticker>`.

## Try the watchlist

```bash
# 1. Boot the web app
cd web && pnpm dev   # http://localhost:7430/watchlist

# 2. Add a ticker with a note
curl -s -X POST http://localhost:7430/api/watchlist \
  -H 'content-type: application/json' \
  -d '{"ticker":"AAPL","note":"earnings 2/1"}'

# 3. List everything
curl -s http://localhost:7430/api/watchlist | jq .

# 3a. Set price targets
curl -s -X PATCH http://localhost:7430/api/watchlist/AAPL \
  -H 'content-type: application/json' \
  -d '{"target_high": 250, "target_low": 180}'

# 3b. Check tickers against the latest run close. Fires a one-shot activity
#     event the first time a target is crossed, then stays quiet until the
#     side flips or the targets change.
curl -s http://localhost:7430/api/watchlist/check | jq .

# 4. Export as CSV
curl -s 'http://localhost:7430/api/watchlist?format=csv' -o watchlist.csv

# 5. Remove a ticker
curl -s -X DELETE http://localhost:7430/api/watchlist/AAPL
```

- User-managed API keys with scopes (`read`, `trade`), one-time secret reveal, revocation, last-used timestamps; managed at `/settings/keys` in the dashboard or via `/admin/keys` over HTTP
- Save & share regime runs from `/demo` to permanent public URLs at `/r/<id>`; manage saved runs at `/history` (rename, re-run, copy link, delete, tag)
- Batch regime scan at `/batch`: paste tickers or drop a CSV, classify up to 50 in one pass, save each as a shareable run, export the whole batch as CSV or JSON
- Free-tier usage meter at `/usage`: real per-month quota of saved runs, daily activity chart, top tickers, regime breakdown, and upgrade CTA; live quota pill in the header that links to `/usage`
- Guided 3-step onboarding at `/welcome`: unlock the terminal, run a real regime classification on a deterministic seeded series, save it to history with the `#onboarding` tag; dismissible homepage banner points new users to it and a replay button lets anyone redo the tour
- Installable PWA with offline shell: Chrome/Edge/Android show an "Install SignalClaw" prompt, iOS supports Add to Home Screen, and a service worker caches the app shell so cached pages keep loading without a network. See `/manifest.webmanifest` and `/offline`.
- In-app activity feed at `/activity`: every saved run, batch scan, webhook delivery, and API key mint is captured with a real event log; the header bell shows an unread badge, the page supports kind filters, unread-only view, mark read, delete, and clear. Backed by `GET/PATCH/DELETE /api/activity` and `PATCH/DELETE /api/activity/<id>`.

## Try the activity feed

```bash
# 1. Boot the web app
cd web && pnpm dev   # http://localhost:7430

# 2. Trigger some events
curl -s http://localhost:7430/api/activity | jq .unread
# Save a run from /demo, fire a webhook from /webhooks, or run a batch from /batch.

# 3. List recent activity
curl -s 'http://localhost:7430/api/activity?limit=10' | jq '.events[] | {kind, title, read}'

# 4. Mark them all read
curl -s -X PATCH http://localhost:7430/api/activity \
  -H 'content-type: application/json' \
  -d '{"action":"mark_all_read"}'
```

The header bell (next to the quota meter) polls every twenty seconds and shows the live unread count. Click it to open `/activity`.


## Install as a desktop or mobile app

The web app ships as a PWA. After `pnpm build && pnpm start` (or any production deploy), Chrome and Edge surface a built-in install button in the URL bar and SignalClaw also pops a small "Install" pill in the bottom right corner the first time `beforeinstallprompt` fires. iOS Safari users can pick Share, then "Add to Home Screen". Once installed it runs in its own window with no browser chrome.

A service worker (`public/sw.js`) precaches the app shell and falls back to `/offline` when the network is unreachable. API traffic (`/api/*`, `/v1/*`, `/admin/*`, `/webhooks/*`) is never cached. Inspect the manifest at:

```bash
curl -s http://localhost:7430/manifest.webmanifest | head
```

## Try the welcome flow

1. Run the dev server: `cd web && npm install && npm run dev` (port 7430)
2. Open <http://localhost:7430/welcome> in a fresh browser profile and step through unlock, sample run, and save.
3. Your seeded run appears in `/history` tagged `#onboarding #sample` and has a working public share URL at `/r/<id>`.

Or seed a sample run directly from the API:

```bash
curl -s -X POST http://localhost:7430/api/welcome/seed \
  -H 'content-type: application/json' \
  -d '{"ticker":"acme"}'
# => {"id":"...","label":"ACME · welcome sample","ticker":"ACME"}
```

## Try the usage meter

1. Run the dev server: `cd web && npm install && npm run dev` (port 7430)
2. Save a few runs from `/demo` or `/batch`.
3. Open <http://localhost:7430/usage> to see your monthly quota, daily activity, and top tickers.

Or from the command line:

```bash
curl -s http://localhost:7430/api/usage | jq '{used, limit, remaining, pct, resets_at}'
```

The free tier limit defaults to 50 saved runs per calendar month (UTC). Override with `SIGNALCLAW_FREE_TIER_LIMIT=200` in the web env.

## Try the batch scanner

1. Run the dev server: `cd web && npm install && npm run dev` (port 7430)
2. Start the backend: `signalclaw serve` or `services/api/run.sh` (port 7431)
3. Open <http://localhost:7430/batch>, click "Load sample", hit Run.

Or from the command line:

```bash
curl -s -X POST http://localhost:7430/api/batch \
  -H 'content-type: application/json' \
  -d '{"tickers":["SPY","QQQ","IWM","TLT","GLD"],"lookback_days":504,"save":true}' | jq .
```

Add `"format":"csv"` to stream a CSV download instead of JSON.

## Try run tags

Organize saved runs by lightweight tags (lowercase, slug-style, up to 8 per run). Tags are searchable, filterable, and round-trip through the CSV/JSON export.

1. Open <http://localhost:7430/history>, click the dashed `add tag` chip on any saved run, type `swing, watch, q2`, hit Enter.
2. The tag bar above the list shows every tag with a count. Click one to filter.

Or from the command line:

```bash
# Set tags on a saved run
curl -s -X PATCH http://localhost:7430/api/runs/<id> \
  -H 'content-type: application/json' \
  -d '{"tags":["swing","watch"]}'

# List all tags with counts
curl -s http://localhost:7430/api/runs/tags | jq .

# Filter the history feed by tag
curl -s 'http://localhost:7430/api/runs?tag=swing' | jq '.runs | length'
```

## Try run notes

Every saved run can carry a free form note up to 2000 chars. Use it to capture why this run matters: the setup, the catalyst, what to watch next. Notes show up on the history list and on the public share page at `/r/<id>` so a copied link arrives with context already attached.

1. Open <http://localhost:7430/history>, click `add notes` on any saved run, type your reasoning, hit cmd+enter.
2. The note renders as a two line preview on the list and as a full block on the public share page.

Or from the command line:

```bash
# Attach notes to a saved run
curl -s -X PATCH http://localhost:7430/api/runs/<id> \
  -H 'content-type: application/json' \
  -d '{"notes":"rate cut day, clean breakout above 440, watch for retest"}'

# Clear notes
curl -s -X PATCH http://localhost:7430/api/runs/<id> \
  -H 'content-type: application/json' \
  -d '{"notes":""}'
```
- Next.js dashboard (pages per resource) with lightweight-charts and recharts

## Try the public export and usage API

```bash
# Export every run you have matching SPY as CSV.
curl -o spy.csv 'http://localhost:7430/api/v1/runs/export?format=csv&ticker=SPY' \
  -H 'Authorization: Bearer sc_live_YOUR_KEY'

# Export a single run as JSON.
curl 'http://localhost:7430/api/v1/runs/<id>/export?format=json' \
  -H 'Authorization: Bearer sc_live_YOUR_KEY' | jq .

# Read your free-tier usage meter.
curl http://localhost:7430/api/v1/usage \
  -H 'Authorization: Bearer sc_live_YOUR_KEY'

# Delete a saved run (trade scope required).
curl -X DELETE http://localhost:7430/api/v1/runs/<id> \
  -H 'Authorization: Bearer sc_live_YOUR_TRADE_KEY'
```

## Try the PDF report

Every saved run gets a one-page PDF report with the regime label, confidence, vol, drawdown, trend slope, a close-price sparkline, and the regime distribution. No browser print dialog, no headless Chrome, just a clean download.

1. Open <http://localhost:7430/history>, hit the **PDF** button on any row.
2. Or open a public share page like <http://localhost:7430/r/SOME_ID> and click **Download PDF**.

From the command line, either the public route (matches share-page visibility):

```bash
curl -L -o report.pdf http://localhost:7430/api/runs/<id>/pdf
```

Or the authed v1 route, for pipelines that already use a minted API key:

```bash
curl -L -H "Authorization: Bearer $SC_API_KEY" \
  -o report.pdf http://localhost:7430/api/v1/runs/<id>/pdf
```

## Try the webhooks

Real outbound HTTP delivery for pick events with HMAC signing, retries with exponential backoff on 5xx / 429 / network errors, and a persisted delivery log. Visit `http://localhost:7430/webhooks`, paste an https URL, choose the events you want, optionally set an HMAC secret. Hit "Fire latest" to send a synthesized `entered` event from your most recent saved run. Inspect attempts in the delivery log card, filter by `all` / `ok` / `failed`, and **Replay** any failed attempt to re-deliver the exact same signed payload byte-for-byte (same body, same HMAC).

```sh
curl -sS http://localhost:7430/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://webhook.site/your-id","events":["entered","exited"],"tickers":["SPY"]}'

curl -sS -X POST http://localhost:7430/webhooks/fire/latest
curl -sS 'http://localhost:7430/webhooks/deliveries?limit=10&status=failed'
curl -sS -X POST http://localhost:7430/webhooks/deliveries/<delivery-id>/replay
```

Deliveries retry up to 3 times with exponential backoff on 5xx/429/network errors. When a secret is set, each request is signed: `x-signalclaw-signature: t=<unix>,v1=<hex hmac of "<t>.<body>">` using HMAC-SHA256.

## Stack

- Python 3.11+, FastAPI, Pydantic v2, uvicorn, Click, structlog
- pandas, numpy, scikit-learn, lightgbm, xgboost, torch, transformers
- yfinance for OHLCV, feedparser for news
- Storage: local files under `DATA_DIR` (parquet via pyarrow, JSON)
- Web: Next.js 15, React 19, TypeScript, Tailwind v4, SWR, lightweight-charts, recharts, Phosphor icons
- Tests: pytest, hypothesis
- Optional: OpenTelemetry OTLP exporter

## Architecture

API process (FastAPI on :7431) owns all state under `DATA_DIR`. The web app (Next.js on :7430) is a read/write client talking only to the API with `SIGNALCLAW_API_KEY`. The CLI shares the same Python package, so `ingest`, `run`, `backtest`, `optimize` produce artifacts the API serves. The notifier is a synchronous module invoked by alert / bracket / stop checks and webhook fires, with a DLQ for retries.

```
yfinance / feedparser
        |
        v
   ingest  ----> data/ (parquet, json)
        |
        v
  features + models + sentiment + news_events
        |
        v
   signal-engine  ----> daily report (picks)
        |
        +--> regime detect ---> risk-scale
        |
        +--> risk.pretrade ---> execution.router (TWAP/VWAP/POV)
        |
        v
   portfolio + brackets + stops + alerts + journal
        |
        v
   notifier (telegram / discord / slack / webhooks, DLQ)

   web (Next.js :7430)  <--->  api (FastAPI :7431)  <--->  data/
```

## Quick start

```bash
git clone <repo> signalclaw && cd signalclaw

# Python env
python3 -m venv .venv && source .venv/bin/activate
pip install -e .

# Env
cp .env.example .env
# at minimum set SIGNALCLAW_API_KEY and SIGNALCLAW_DASHBOARD_PASSWORD

# Seed data
signalclaw ingest --period 3y

# API (port 7431)
uvicorn signalclaw.api:app --host 0.0.0.0 --port 7431
# or: signalclaw serve

# Web (port 7430)
cd web && npm install && npm run dev
```

Or via docker compose:

```bash
docker compose -f docker-compose.dev.yml up --build
```

No external broker is required. The execution simulator is offline and yfinance covers data. Optional notifier credentials (Telegram / Discord / Slack / NewsAPI) can be added to `.env`.

## Try it: ticker page with regime overlay

Open any symbol at `http://localhost:7430/ticker/SPY` (or QQQ, AAPL, etc.) to see the live price chart with bull / chop / bear / crash markers under each bar, regime bar counts, and the current snapshot (label, risk scale, confidence). Lookback toggles between 1Y / 2Y / 5Y.

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/regime/series?ticker=SPY&lookback_days=504" | jq '.counts, .snapshot'
```

## Try it: explain a signal

See exactly why the model picked watch, hold, or skip for any ticker. The `/explain/{ticker}` endpoint runs the same per-ticker pipeline used by daily picks (technical features, ensemble classifier, return regressor) and returns the prediction with per-feature contributions, rationale text, risk flags, and a price history window.

Web: http://localhost:7430/explain — sample selector (SPY, QQQ, AAPL, NVDA, TLT, BTC-USD) or any custom ticker, 3M/6M/1Y/2Y windows, class probability bar, price spark, bullish vs bearish feature panels with weighted contribution bars, and risk flag badges.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/explain/SPY?lookback_days=120" | jq '{label, score, expected_return, proba, rationale, risk_flags}'
```

## Try it: public demo (no signup)

For a first look at SignalClaw without setup, open the public demo. It calls a rate-limited, unauthenticated endpoint locked to a small allowlist of liquid tickers (SPY, QQQ, IWM, TLT, GLD, BTC-USD), runs the real regime classifier, and shows a live price chart with bull / chop / bear / crash overlay plus a snapshot of realized vol, trend slope, and drawdown.

Web: http://localhost:7430/demo

API:

```bash
curl "http://localhost:7431/public/regime/demo?ticker=SPY&lookback_days=504" | jq '.snapshot, .counts'
```

## Try it: save and share a regime run

Hit **Save & share** on `/demo` to snapshot the chart, stats, and regime mix to a permanent, public URL. Anyone can open the link without signing in, and the data is frozen at save time so the chart never drifts. Each share URL renders a dynamic Open Graph + Twitter preview card at `/r/<id>/opengraph-image` (ticker, regime badge, confidence, vol, drawdown, sparkline) so links unfurl nicely in Slack, Discord, iMessage, and X. The share page itself has a one click **Copy link** button. Manage your saves at `/history`: search by label, ticker, or id, filter by regime, paginate, rename, re-run with the same parameters, copy the share link, export to CSV or JSON, or delete.

```bash
# Verify the share preview image renders (1200x630 PNG)
curl -sI http://localhost:7430/r/abc1234567/opengraph-image | head -2
# => HTTP/1.1 200 OK
# => content-type: image/png
```

Web: http://localhost:7430/history

API:

```bash
# Save a run
curl -X POST http://localhost:7430/api/runs \
  -H 'content-type: application/json' \
  -d '{
    "ticker": "SPY",
    "lookback_days": 504,
    "label": "SPY 2Y",
    "payload": { "ticker": "SPY", "dates": ["2024-01-02"], "close": [470.1], "regime": ["bull"], "counts": {"bull": 1}, "snapshot": null, "disclaimer": "research only" }
  }'
# => {"id": "abc1234567", ...}

# Open share page
open http://localhost:7430/r/abc1234567

# List saved runs (paginated, filtered)
curl 'http://localhost:7430/api/runs?q=spy&regime=bull&limit=25&offset=0'

# Rename
curl -X PATCH http://localhost:7430/api/runs/abc1234567 \
  -H 'content-type: application/json' -d '{"label":"My SPY snapshot"}'

# Delete
curl -X DELETE http://localhost:7430/api/runs/abc1234567

# Export a single run as CSV (one row per bar)
curl -OJ 'http://localhost:7430/api/runs/abc1234567/export?format=csv'

# Bulk export all matching runs as CSV or JSON
curl -OJ 'http://localhost:7430/api/runs/export?regime=bull&format=csv'
curl -OJ 'http://localhost:7430/api/runs/export?q=spy&format=json'
```

## Try it: mint a scoped API key and call the v1 API

User-managed keys are served by the Next app itself (file-backed, atomic writes, SHA-256 hashed at rest). The dashboard at `/settings/keys` lists, mints, rotates, and revokes them; secrets are revealed exactly once at creation or rotation. Scopes `read` and `trade` can be granted from the UI; `admin` is server-config only (set `SIGNALCLAW_ADMIN_KEY` in the env) to prevent privilege escalation.

Rotation keeps the key's id, label, and scopes intact (so dashboards, activity entries, and bookmarks keep working) while invalidating the old secret immediately and resetting `last_used_at`. Use it when a key is suspected leaked but you don't want to tear down whatever it's attached to.

Web: <http://localhost:7430/settings/keys>

The minted key unlocks the public `/v1/*` endpoints over bearer auth. Today that covers `GET /v1/runs` (with search, regime filter, ticker filter, limit, offset), `GET /v1/runs/:id` (full payload plus a `share_url`), and `POST /v1/runs` (classify a price series you supply and persist the result; requires the `trade` scope).

```bash
# mint a key (single-user mode; set SIGNALCLAW_ADMIN_KEY to require auth here)
curl -X POST http://localhost:7430/admin/keys \
  -H 'content-type: application/json' \
  -d '{"label":"my laptop","scopes":["read"]}'
# response includes "secret": "sc_live_..." once; copy it now

export SC_KEY=sc_live_paste_here

# list saved regime runs (paginated, filterable)
curl 'http://localhost:7430/v1/runs?regime=bull&limit=10' \
  -H "Authorization: Bearer $SC_KEY"

# fetch one run with its full payload
curl http://localhost:7430/v1/runs/<id> -H "Authorization: Bearer $SC_KEY"

# classify your own price series and save the run (trade scope required)
curl -X POST http://localhost:7430/v1/runs \
  -H "Authorization: Bearer $SC_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "ticker": "SPY",
    "label": "my first api run",
    "close": [470.1,471.5,469.8,472.0,473.2,474.6,473.9,475.1,476.3,477.8,
               478.5,479.2,480.0,481.1,482.4,483.0,484.2,485.5,486.1,487.0,
               488.3,489.2,490.5,491.7,492.4,493.1,494.0,495.3,496.2,497.5,
               498.1,499.0]
  }'
# response: { id, label, snapshot, share_url, ... }; open share_url to view it

# rotate a key in place: same id and scopes, brand new secret, old one stops working now
curl -X POST http://localhost:7430/admin/keys/<id>/rotate
# response includes the new "secret": "sc_live_..." once; copy it now

# revoke a key when compromised beyond rotation
curl -X DELETE http://localhost:7430/admin/keys/<id>

# whoami: confirm your key is wired up before any real call (read scope)
curl http://localhost:7430/api/v1/whoami -H "Authorization: Bearer $SC_KEY"
# response: { id, label, prefix, scopes, created_at, last_used_at, server_time }
```

## Try it: interactive API reference

Every v1 endpoint is documented on a single page with copy-paste curl, sample responses, scope badges, and a live "Try it" button that runs the GET endpoints against the key your browser is signed in with. Lands you straight in your terminal after minting a key, no separate tab to a hosted docs site.

Web: <http://localhost:7430/docs>

```bash
# the same call the page makes when you click Try it on /api/v1/whoami
curl -H "Authorization: Bearer $SC_KEY" http://localhost:7430/api/v1/whoami
```

## Try it: regime classifier

Classify any ticker into bull, chop, bear, or crash from realized vol, 60d trend slope, and 252d drawdown. Used by the picks engine to scale position sizes (crash 0.25x, bear 0.5x, chop 0.75x, bull 1.25x).

Web: http://localhost:7430/regime — sample selector (SPY, QQQ, IWM, TLT, GLD, BTC-USD), 6M/1Y/2Y/5Y windows, price chart with per-bar regime markers, snapshot stats, and a time-in-regime breakdown.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  "http://localhost:7431/regime/series?ticker=SPY&lookback_days=504" | jq '.snapshot, .counts'
```

## Try it: walk-forward backtest

Run a real walk-forward backtest on any ticker. The model trains on a rolling 252-day window, steps forward 21 bars at a time, and takes long-only positions when its watch/hold/skip classifier is confident. No look-ahead. Costs and slippage applied per turnover.

Web: http://localhost:7430/backtest — sample selector (SPY, QQQ, AAPL, NVDA, TLT, BTC-USD), equity vs buy-and-hold overlay with entry/exit markers, drawdown pane, trade table, and an alpha summary.

API:

```bash
curl -H "x-api-key: $SIGNALCLAW_API_KEY" \
  http://localhost:7431/backtest/SPY | jq '{cagr, benchmark_cagr, sharpe, max_drawdown, exposure, n_trades}'
```

## Configuration

| Var | Purpose |
|---|---|
| `SIGNALCLAW_API_KEY` | Bearer key required by all non-public API routes |
| `SIGNALCLAW_DASHBOARD_PASSWORD` | Web dashboard password |
| `DATA_DIR` | Path for parquet / json state (default `./data`) |
| `LOG_LEVEL` | structlog level (default `INFO`) |
| `TELEGRAM_ENABLED` | Toggle Telegram notifier |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram creds |
| `DISCORD_WEBHOOK_URL` | Discord notifier URL |
| `SLACK_WEBHOOK_URL` | Slack notifier URL |
| `NEWSAPI_KEY` | NewsAPI key for news events |
| `ENABLE_CI` | Toggle CI-only paths |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP traces endpoint |

## Scripts

CLI (`signalclaw <cmd>`, defined in `pyproject.toml` and `src/signalclaw/cli/main.py`):

| Command | Purpose |
|---|---|
| `ingest` | Pull OHLCV for the watchlist (`--period`) |
| `run` | Generate today's picks (`--today`, `--notify`, `--out`) |
| `backtest` | Backtest one ticker or the watchlist (`--ticker`, `--from`, `--period`) |
| `optimize` | Walk-forward param sweep (`--train`, `--test`, `--period`) |
| `serve` | Run the FastAPI app (`--host`, `--port`) |
| `size` | Position sizing helper (`--equity`, `--risk`, `--max-pct`) |
| `correlation` | Pairwise correlation matrix (`--window`, `--threshold`) |
| `rotation` | Rotation scoring report |
| `pretrade` | Pretrade risk check |

Makefile shortcuts: `make dev`, `make test`, `make api`, `make web`, `make ingest`, `make run`, `make backtest`.

Web (`web/`): `npm run dev`, `npm run build`, `npm run start`, `npm run lint`.

## API

All routes except `/health` and `/disclaimer` require `Authorization: Bearer $SIGNALCLAW_API_KEY`.

Public

- `GET /health`
- `GET /disclaimer`

Watchlist + picks + reports

- `GET/POST/DELETE /watchlist[/{ticker}]`
- `GET /picks`, `GET /picks/guarded`
- `GET /report.md`
- `GET /reports/history`, `GET /reports/{as_of}`
- `GET /reports/diff/latest`, `GET /reports/diff/{as_of}`
- `POST /reports/archive`

Backtest + optimization

- `GET /backtest/{ticker}`
- `GET /optimize/{ticker}` (walk-forward)

Portfolio

- `GET/POST/DELETE /portfolio/trades[/{trade_id}]`
- `GET /portfolio/snapshot`
- `GET /portfolio/attribution`
- `GET /portfolio/sectors`
- `GET /portfolio/tax`
- `GET /portfolio/drawdown`, `GET /portfolio/drawdown/history`, `POST /portfolio/drawdown/clear`
- `GET/POST/DELETE /portfolio/currency[/{trade_id}]`
- `GET /portfolio/converted`

Risk + execution

- `POST /risk/size`
- `POST /risk/pretrade`
- `POST /execution/simulate`

Correlation + diversification + rotation + regime

- `GET /correlation`
- `GET /diversification`
- `GET /rotation`
- `GET /regime`

Alerts + stops + brackets + scaling

- `GET/POST/DELETE /alerts[/{alert_id}]`, `POST /alerts/check`
- `GET /alerts/history?ticker=&limit=&offset=` and `DELETE /alerts/history/clear`
  return a rolling, paginated log of every alert fire with target vs. observed values.
  Also surfaced as a Fire history card on `/alerts` in the web UI.
- `GET/POST/DELETE /stops[/{rule_id}]`, `POST /stops/check`
- `GET/POST/DELETE /brackets[/{plan_id}]`, `GET /brackets/stats`
- `POST /brackets/{plan_id}/fill|close|cancel`
- `GET/POST/DELETE /scaling/plans[/{plan_id}]`, `POST /scaling/plans/{plan_id}/cancel|evaluate`

Journal

- `GET/POST/DELETE /journal[/{trade_id}]`
- `GET /journal/stats/conviction`

News + earnings + quality

- `GET/POST/DELETE /news-events[/{event_id}]`
- `GET /news-events/study`
- `GET/PUT/DELETE /earnings[/{ticker}]`
- `GET /quality/anomalies/{ticker}`

FX + ledger

- `GET/POST /fx`, `GET /fx/{currency}`
- `GET/POST /ledger/{account}`, `GET /ledger/{account}/snapshot`, `PUT /ledger/{account}/config`

Webhooks + notifier

- `GET/POST/DELETE /webhooks[/{sub_id}]`, `POST /webhooks/fire/latest`
- `GET/DELETE /notifier/dlq[/{item_id}]`, `POST /notifier/dlq/replay`, `POST /notifier/test`

Source of truth: `src/signalclaw/api/app.py`.

## Backtesting + Optimization

The walk-forward optimizer lives in `src/signalclaw/backtest/walk_forward_opt.py`. Strategy template is long-only SMA crossover with an RSI filter:

```
signal[t] = 1 if SMA(close, fast) > SMA(close, slow)
                 and RSI(close, rsi_period) > rsi_min
            else 0
```

Each fold grid-searches params on the train slice, picks the in-sample best-Sharpe pair, and records OOS Sharpe / return / MDD on the test slice. Run it:

```bash
signalclaw optimize SPY --train 252 --test 63 --period 5y
# or
curl -H "Authorization: Bearer $SIGNALCLAW_API_KEY" \
     "http://localhost:7431/optimize/SPY?train=252&test=63"
```

Output reports per-fold params and OOS metrics, plus aggregates (median OOS Sharpe, mean OOS return, most common params and their share). Selection never sees the test slice, so OOS Sharpe is honest.

## Execution simulator

`src/signalclaw/execution/router.py` slices a parent order into per-bar children:

- `TWAP`: equal weight across bars
- `VWAP`: proportional to a supplied session volume curve
- `POV`: participation rate of realized volume

Each slice can be capped at `max_participation` of bar volume; per-share slippage scales linearly with the slice's share of ADV. The report returns realized average price, cost vs the arrival price and the interval-VWAP benchmark, and an implementation-shortfall breakdown. Use `POST /execution/simulate` with explicit bars (the simulator never fetches market data itself).

## Project structure

```
.
├── src/signalclaw/         # Python package (api, cli, engine, backtest, execution, regime, ...)
├── packages/               # backtest, data, explain, features, models (extracted libs)
├── services/               # api, ingest, notifier, signal-engine
├── web/                    # Next.js dashboard (app router)
├── infra/docker/           # Dockerfile.api, Dockerfile.web, compose files
├── scripts/                # ops scripts
├── docs/                   # architecture, ADRs, playbook, screenshots
├── tests/                  # pytest + hypothesis
├── data/                   # local state (parquet / json)
├── pyproject.toml
├── Makefile
└── .env.example
```

## License

MIT. See `LICENSE`.

## Operations

Operational notes for running SignalClaw beyond a single laptop.

### Audit log

Every mutating API call (POST, PUT, PATCH, DELETE) and every authentication or
authorization failure on a protected route is persisted to an append-only JSONL
file under `<DATA_DIR>/audit/audit-YYYY-MM-DD.jsonl`. Files rotate daily by
filename so they can be tailed, grepped, or shipped to a SIEM with standard
tooling.

Each record contains the request id, UTC timestamp, method, path, response
status, source IP, request duration, and the API key's label plus a stable
SHA-256 prefix as `actor_key_hash`. The raw key is never written. Request
bodies and response payloads are never written.

Query recent events over HTTP (admin scope required):

```
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/audit?limit=100
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/audit/days
curl -H "x-api-key: $ADMIN_KEY" "http://localhost:8000/audit?day=2026-05-30"
```

Flip on read-side auditing during incident response by setting
`SIGNALCLAW_AUDIT_READS=1` and restarting the API. Health, docs, and metrics
endpoints are always exempt.

Clients can supply `x-request-id`; the value is echoed back on the response and
recorded in the audit row so logs across the stack can be correlated. When the
header is absent the middleware mints a 16-char id. See the
[Request correlation](#request-correlation) section below for the full
propagation story.

### Audit retention

Audit JSONL files are pruned by a background daemon thread that starts with
the API process. Files whose date stamp is strictly older than the configured
threshold are deleted on a fixed sweep interval and on every process start so
a long-stopped service catches up immediately.

Configuration is environment driven and ships with safe defaults:

- `SIGNALCLAW_AUDIT_RETENTION_DAYS` (default `90`). Maximum age in UTC days.
  Set to `0` to disable retention entirely, which is only appropriate when an
  external log shipper has taken ownership of the directory.
- `SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS` (default `3600`). How often
  the sweeper wakes. The minimum effective value is 60 seconds; invalid input
  falls back to the default rather than crashing boot.

Each sweep that deletes one or more files emits a structured log line:

```
audit.retention.pruned files_removed=3 retention_days=90
```

The Helm chart exposes both knobs under `api.audit.retentionDays` and
`api.audit.retentionIntervalSeconds` in `values.yaml`, and renders them as
environment variables on the API deployment. To override the retention
window without disabling the sweeper, set the value at install time:

```
helm upgrade signalclaw infra/helm/signalclaw \
  --set api.audit.retentionDays=30
```

For compliance flows that require a permanent record, ship the audit
directory to an external write-once store (S3 with object lock, GCS bucket
lock, etc.) on a schedule shorter than the retention window. The sweeper
never touches files outside the `audit-YYYY-MM-DD.jsonl` glob, so an
adjacent staging directory is safe to colocate.

### Request correlation

Every inbound request is wrapped by `RequestContextMiddleware` (outermost
middleware on the API). It:

- Honours an inbound `X-Request-Id` header when the value matches
  `[A-Za-z0-9_-]{1,128}`, otherwise mints a fresh 16-char hex id. Malformed
  ids are dropped rather than logged, so a hostile caller cannot inject
  newlines or control characters into the log stream.
- Honours an optional `X-Correlation-Id` header for cross-system tracing
  (for example a job id from an upstream scheduler). This header is never
  minted; it is only propagated when supplied.
- Binds both ids into `structlog` contextvars so every log line emitted
  during the request, from any module, automatically carries `request_id`
  (and `correlation_id` when present) without each handler having to thread
  them manually.
- Echoes both ids back on the response and exposes them on
  `request.state.request_id` / `request.state.correlation_id` for downstream
  middleware. The audit middleware reads `request.state.request_id` so the
  audit row and the JSON logs share a single id.
- Clears the contextvars on the way out so a worker process serving the
  next request starts clean.

Grep workflow during an incident:

```
rid=$(curl -sI http://api/health | awk '/x-request-id/ {print $2}' | tr -d '\r')
jq -c "select(.request_id==\"$rid\")" /var/log/signalclaw/*.json
grep "\"request_id\":\"$rid\"" "$DATA_DIR"/audit/audit-*.jsonl
```

Retention is operator-controlled. A simple cron is sufficient:

```
find "$DATA_DIR/audit" -name 'audit-*.jsonl' -mtime +90 -delete
```

### RBAC scope enforcement

API keys carry scopes (`read`, `trade`, `admin`). A global middleware
(`ScopeEnforcementMiddleware`) maps every inbound request to the scope it
requires using the `SCOPE_RULES` table in `src/signalclaw/api/rate_limit.py`:

- `GET` against any non-exempt path needs `read`.
- `POST` / `PUT` / `PATCH` / `DELETE` against `/watchlist`, `/alerts`,
  `/portfolio/trades`, `/stops`, `/earnings`, and `/reports/archive` needs
  `trade`.
- Anything under `/admin/` needs `admin`.
- `admin` implicitly grants `read` and `trade`.

A read-only key calling a mutating route now gets a `403` with a JSON body
describing the required scope, the method, and the path, instead of being
let through because the route author forgot a per-route dependency. Health,
readiness, docs, and `/metrics` are exempt.

Configure multiple keys via `SIGNALCLAW_API_KEYS_JSON`:

```
export SIGNALCLAW_API_KEYS_JSON='[
  {"key":"ro-monitor","scopes":["read"],"label":"grafana"},
  {"key":"bot-trader","scopes":["read","trade"],"label":"discord-bot","rate_per_minute":120},
  {"key":"admin-sanjay","scopes":["read","trade","admin"],"label":"sanjay"}
]'
```

The legacy `SIGNALCLAW_API_KEY` env still works and is granted `read` +
`trade` for backwards compatibility. Rotate to the JSON form when you need
an admin key (admin endpoints are deliberately not granted to the legacy
key).

Enforcement is on by default. Set `SIGNALCLAW_RBAC_ENFORCE=0` to fall back
to the old permissive behaviour during a migration window. Coverage lives
in `tests/test_rbac_enforcement.py`.

### Metrics and probes

The API exposes Prometheus metrics at `GET /metrics` in the standard
text exposition format. The endpoint is open (no API key) so that
scrapers running inside the cluster can reach it without rotating
secrets; lock it down at the ingress or NetworkPolicy layer if you
expose the API to the public internet.

Series currently exported:

- `signalclaw_http_requests_total{method,route,status}` counter
- `signalclaw_http_request_duration_seconds{method,route}` histogram
  with buckets at 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s,
  2.5s, 5s, 10s
- `signalclaw_http_in_flight_requests` gauge
- `signalclaw_build_info{version}` gauge pinned at 1

The `route` label uses the FastAPI route template (for example
`/watchlist/{ticker}`) so cardinality stays bounded under scanner or
fuzzer traffic. Unmatched paths bucket into `__unmatched__`.

Two probe endpoints back the Helm chart:

- `GET /health` is a cheap liveness probe. No I/O, no auth. If the
  process answers, Kubernetes leaves it running.
- `GET /ready` is a readiness probe. It confirms that `DATA_DIR` is
  writable by touching a `.ready_probe` file. Returns 503 when the
  data volume is missing or read-only so the service mesh removes the
  pod from rotation instead of serving 500s.

The deployment template adds standard `prometheus.io/scrape`
annotations so a default kube-prometheus install picks the API up
automatically.

### Error tracking (Sentry)

The API ships with an optional [Sentry](https://sentry.io) integration. It
stays inert until you set `SENTRY_DSN`, so local dev and CI never need a real
project or network access.

Enable it by setting these environment variables (see `.env.example`):

```
SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production         # or staging / development
SENTRY_RELEASE=0.1.0                  # usually the git SHA in CI
SENTRY_TRACES_SAMPLE_RATE=0.05        # 0.0 disables performance traces
SENTRY_PROFILES_SAMPLE_RATE=0.0       # 0.0 disables profiling
SENTRY_SEND_DEFAULT_PII=false         # leave false unless you really need it
```

What it captures:

- Unhandled exceptions from any FastAPI route, including the route
  template as the transaction name so issues group cleanly.
- `logging` records at `ERROR` or above are sent as events; `WARNING`
  and above become breadcrumbs on whatever event ships next.
- Optional performance traces and profiles, gated by the sample rate
  envs. Keep these low in production to control quota.

Before any event leaves the process the SDK runs a local scrubber that
redacts the `Authorization`, `Cookie`, and `X-Api-Key` headers and
strips any captured request body. PII is off by default. Combined with
the existing audit log (which never sees request bodies either), no
secrets or user payloads should reach the Sentry project.

Smoke test after rollout: trigger any handler that raises and confirm
the event appears in the Sentry project under the configured
`SENTRY_ENVIRONMENT`. The startup log line `sentry.enabled` confirms
the SDK initialised inside the pod.

### Distributed tracing (OpenTelemetry)

The API ships a real OpenTelemetry pipeline: a `TracerProvider` with a
stable `service.name` resource, OTLP/HTTP span export, and ASGI plus
httpx auto-instrumentation. It stays inert until you point
`OTEL_EXPORTER_OTLP_ENDPOINT` at a collector, so local dev and CI never
need a running OTel stack.

Enable it by setting these environment variables (see `.env.example`):

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_TRACES_SAMPLER_ARG=0.1          # 0.0 to 1.0 parent-based ratio sampler
OTEL_SERVICE_VERSION=0.1.0           # optional, falls back to package version
```

If the endpoint already includes the `/v1/traces` path it is used as-is;
otherwise the OTLP/HTTP exporter appends it. The standard upstream
`OTEL_EXPORTER_OTLP_HEADERS` is honoured by the exporter for tenant
authentication against managed backends (Honeycomb, Grafana Cloud,
Datadog OTLP intake).

What gets traced:

- Every inbound HTTP request via the FastAPI ASGI instrumentor. Span
  names use the route template (for example `GET /watchlist/{ticker}`)
  so cardinality stays bounded.
- Every outbound httpx call (yfinance fetches, notifier webhooks)
  becomes a child span under the request that triggered it.
- `/health`, `/ready`, and `/metrics` are excluded from span creation
  so probe and scrape traffic do not drown out real signal.

Log and trace correlation:

`RequestContextMiddleware` reads the active span context inside every
request and binds `trace_id` plus `span_id` into the `structlog`
contextvars alongside `request_id`. Every structured log line emitted
during the request automatically carries all three, so you can click
from a Sentry event or a log search straight to the matching trace in
your OTel backend without manually stitching ids. When tracing is
disabled the trace fields are simply absent.

Sampling guidance:

- Dev and CI: leave `OTEL_TRACES_SAMPLER_ARG=1.0` to record everything.
- Staging: `0.5` is a good starting point while you tune dashboards.
- Production: `0.05` to `0.1` keeps cost predictable; raise it during
  incident response. The sampler is parent-based, so an upstream that
  forces `sampled=1` on a trace context will always be honoured even
  when the local ratio would have dropped it.

Smoke test after rollout: hit any non-exempt endpoint and confirm a
span appears in the collector with `service.name=signalclaw-api` and
`http.route` matching the FastAPI template. Coverage lives in
`tests/test_otel_tracing.py`, which uses an in-memory exporter to
assert that the request middleware and the FastAPI instrumentor
actually emit spans and that the trace id makes it into the log
contextvars.

### Per-IP rate limiting (DoS guard)

A separate `PerIPRateLimitMiddleware` sits outside the per-API-key limiter
so a flood from a single source is shed before auth, audit, or the per-key
buckets see it. The shared `anon` bucket that the per-key limiter uses for
unauthenticated traffic would otherwise be a single chokepoint under abuse;
the per-IP layer keys off the client address so one noisy source cannot
starve every other anonymous caller.

Tunables (all env, no restart-time discovery):

| Var | Default | Effect |
| --- | --- | --- |
| `SIGNALCLAW_PER_IP_PER_MIN` | `600` | Token-bucket capacity and refill in requests per minute per source IP. Set to `0` to disable the layer entirely (not recommended for any public exposure). |
| `SIGNALCLAW_TRUST_FORWARDED` | `0` | When `1`, parse the leftmost entry of `X-Forwarded-For` (or `X-Real-IP` as a fallback) so the bucket keys off the real client behind a reverse proxy. Off by default so a direct attacker cannot spoof the header. |
| `SIGNALCLAW_TRUSTED_PROXIES` | empty | Comma-separated allowlist of peer IPs whose forwarded headers will be honoured. When `SIGNALCLAW_TRUST_FORWARDED=1` and this list is empty, any peer is trusted (use only when the API is never reachable except through a known L7 proxy). |

Exceeded buckets return HTTP 429 with `Retry-After`, an `X-RateLimit-Scope:
per-ip` header, and a JSON body `{"detail":"per-ip rate limit exceeded",
"scope":"per-ip","retry_after_seconds":N}`. Health, readiness, docs, and
`/metrics` are exempt so probes and scrapers are never throttled.

Deployment notes:

- Behind nginx or an ingress controller, set `SIGNALCLAW_TRUST_FORWARDED=1`
  and pin `SIGNALCLAW_TRUSTED_PROXIES` to the proxy pod IPs. Without that,
  every request looks like it came from the proxy and the whole cluster
  shares one bucket.
- The per-IP layer composes with the existing per-key limiter
  (`SIGNALCLAW_RATE_LIMIT_ENABLED=1`): per-IP fires first, per-key fires
  after, and a request must clear both. Tune `SIGNALCLAW_PER_IP_PER_MIN`
  higher than the sum of per-key budgets you expect from a single source.
- Buckets live in-process. With multiple API replicas, each pod enforces
  its own bucket, so the effective ceiling is `replicas * per_minute`.
  That is fine as a DoS guard; for strict global quotas use the per-key
  budgets backed by your gateway.

Coverage lives in `tests/test_per_ip_rate_limit.py`.

### Deployment, scaling, backup, on-call

Deployment is described in `infra/helm/signalclaw` (chart with values) and
`infra/docker/Dockerfile.api`. Scale the API horizontally; rate limits and the
audit log are both per-process safe and append-only, so there is no shared
write contention. Back up `DATA_DIR` (parquet, JSON stores, audit/) on the
same cadence as your other stateful volumes. On-call playbook lives under
`docs/playbook.md`.

The Helm chart ships hardened defaults: non-root pod security context
(`runAsNonRoot`, `seccompProfile: RuntimeDefault`), per-container CPU and
memory requests/limits, dropped Linux capabilities, read-only root filesystem
with `emptyDir` mounts for `/tmp` and `DATA_DIR`, a dedicated
`ServiceAccount` with `automountServiceAccountToken: false`, and Prometheus
scrape annotations on the API pod. Production-only toggles (all opt-in):

| Key | Effect |
| --- | --- |
| `api.autoscaling.enabled=true` | Renders an HPA on CPU and memory utilisation. `web.autoscaling.enabled=true` does the same for the web pod. |
| `api.podDisruptionBudget.enabled=true` | Renders a PDB with `minAvailable: 1` so the API survives node drains. |
| `networkPolicy.enabled=true` | Locks API ingress to the web pod only, restricts egress to DNS plus the configured `egressCIDRs` on 80/443. |
| `api.persistence.enabled=true` | Creates a PVC bound at `DATA_DIR` (default `/data`) so audit log, journal, and parquet stores survive pod restarts. |
| `api.sentry.dsnSecret=<secret>` | Threads `SENTRY_DSN` from the named secret (`key: dsn`) plus environment, release, and sample rates into the API container. |
| `ingress.enabled=true` | Renders an Ingress with `ingressClassName`, `annotations`, and `tls` passthrough from values. |

The chart is covered by `tests/test_helm_chart.py`, which shells out to
`helm template` and asserts every container has resource limits, the pod
security context is non-root, capabilities are dropped, read-only root
filesystem has writable volume mounts, probes are wired to `/health` and
`/ready`, and each opt-in toggle produces the expected manifest. Run
`pytest tests/test_helm_chart.py` after any chart change.

### Data lifecycle (GDPR export and delete)

SignalClaw exposes two endpoints so an operator can fulfil data subject
requests without writing ad hoc scripts. Both require the `admin` scope.

`GET /privacy/export` returns a single JSON blob containing every
user-state record on the instance: watchlist, alerts, portfolio trades,
stops, journal, brackets, earnings calendar, news events, webhooks,
drawdown history, scaling plans, FX currencies, and the full persisted
audit log grouped by UTC day. Stream it to a file:

```
curl -H "x-api-key: $ADMIN_KEY" http://localhost:8000/privacy/export \
  > export-$(date -u +%Y%m%d).json
```

For compliance reviewers who want CSVs they can open in a spreadsheet,
pass `format=zip` (default bundle: one CSV per store plus the raw JSON
and a `MANIFEST.txt` summarising row counts) or `format=csv` (same
ZIP without the JSON copy):

```
curl -H "x-api-key: $ADMIN_KEY" \
  "http://localhost:8000/privacy/export?format=zip" \
  -o export-$(date -u +%Y%m%d).zip
```

`POST /privacy/delete` erases user state in place. To guard against
accidents the call must include `confirm=DELETE` exactly. Audit log,
archived daily reports, and cached OHLCV are preserved by default since
they are typically retained for compliance; opt in per category with
`wipe_audit=true`, `wipe_reports=true`, and `wipe_ohlcv=true`:

```
curl -X POST -H "x-api-key: $ADMIN_KEY" \
  "http://localhost:8000/privacy/delete?confirm=DELETE"
```

Response body returns `{"ok": true, "removed": {...}, "files_removed":
[...], "errors": []}` so the action is itself auditable. The deletion
is also written to the audit log via the standard middleware.

### Container image

The API ships as a hardened multi-stage image defined in
`infra/docker/Dockerfile.api`. The builder stage compiles dependencies and
builds a non-editable wheel into an isolated virtualenv; the runtime stage
copies only that venv onto a slim `python:3.11-slim` base, drops to a
dedicated non-root system account (`signalclaw`, uid/gid 10001), and uses
`tini` as PID 1 so `SIGTERM` from Kubernetes or `docker stop` reaches
uvicorn cleanly. A `HEALTHCHECK` probes `/health` every 30 seconds so
`docker ps` and compose-level restarts see real liveness signal even when
run outside Kubernetes.

Build and run locally:

```
docker build -f infra/docker/Dockerfile.api -t signalclaw-api:local .
docker run --rm -p 7431:7431 --env-file .env signalclaw-api:local
```

The data directory inside the container is `/var/lib/signalclaw`, owned by
the `signalclaw` user. Mount a persistent volume there in production so
the audit log, cached OHLCV, and archived reports survive pod restarts.
The shape of the image (multi-stage, non-root, wheel install, healthcheck,
tini entrypoint) is enforced by `tests/test_docker_api_image.py` so a
regression in any of those properties breaks CI before it ships.

### Lint and dependency audit

The `ci` workflow gates merges on three Python jobs in addition to the
web build:

- `lint` runs `ruff check .` against the entire repo using the config
  in `pyproject.toml` (`[tool.ruff]`). The selected rule set is
  pyflakes plus a focused slice of pycodestyle (`F`, `E4`, `E7`, `E9`,
  `W6`) with per-file ignores for `__init__.py` re-exports and tests.
  Local contributors get the same gate from `pytest`: `tests/test_lint_ruff.py`
  shells out to `ruff check .` and fails the suite when it finds new
  violations. The test is skipped, not failed, when `ruff` is missing
  so a minimal runtime install still passes.
- `test` depends on `lint` and runs the full `pytest -q` suite, so a
  lint regression short-circuits the slower test job and saves runner
  minutes.
- `security-audit` runs `pip-audit --strict` against the installed
  dependency tree. It is marked `continue-on-error: true` so newly
  disclosed advisories surface as a CI warning instead of an outage,
  with the expectation that on-call triages the advisory the same day
  and either pins around it or adds it to the ignore list with a
  link to the upstream fix PR.

A fourth job, `helm`, installs the `helm` CLI on the runner and renders
the chart end to end so the hardening invariants documented above are
actually gated. It runs:

- `helm lint infra/helm/signalclaw` to catch schema regressions.
- `helm template t infra/helm/signalclaw` to confirm the default values
  render without error.
- `pytest tests/test_helm_chart.py tests/test_helm_chart_ci.py` to
  assert resource limits, non-root security context, dropped
  capabilities, read-only root filesystem, probes, and the
  HPA/PDB/NetworkPolicy/PVC/Sentry toggles all produce the expected
  manifests. `test_helm_chart.py` self-skips when `helm` is missing, so
  the dedicated CI job exists to guarantee it never silently skips on
  the GitHub runner. `test_helm_chart_ci.py` parses `ci.yml` itself and
  fails if the helm job ever loses its `azure/setup-helm` install,
  `helm lint`, `helm template`, or PyYAML setup steps, which closes the
  "chart hardening tests skipped because the runner had no helm" loop
  for good.

Run the same gate locally before pushing:

```
ruff check .
pip-audit
helm lint infra/helm/signalclaw
pytest -q
```

### Production secret validation

`Settings` runs a pydantic `model_validator` at boot that refuses to start the
API when known-weak sample secrets survive into a production or staging
rollout. The check is intentionally loud: if it triggers, the process exits
with a `pydantic.ValidationError` listing every offending variable so the
operator can see the full picture in one log line rather than chasing one
failure at a time.

Set the deployment environment with `SIGNALCLAW_ENV`. Accepted values are
`development`, `test`, `staging`, and `production`. Anything else is
rejected at parse time. Local boots default to `development` and skip the
strict checks so workflows like `make api` and the test suite keep working
without extra env wiring.

When `SIGNALCLAW_ENV` is `staging` or `production`, all of the following
must hold or the process refuses to boot:

- `SIGNALCLAW_API_KEY` is not one of the sample values shipped in
  `.env.example` (`change-me-local-dev-only`, `change-me`, `dev-key`, etc.)
  and is at least 16 characters long.
- `SIGNALCLAW_DASHBOARD_PASSWORD` is not a sample value and is at least 16
  characters long.
- `SENTRY_ENVIRONMENT` is not still `development` when `SENTRY_DSN` is set,
  so errors are not mistagged.
- `TELEGRAM_ENABLED=true` is accompanied by a non-empty `TELEGRAM_BOT_TOKEN`,
  so delivery does not silently no-op.

Generate a fresh API key with `openssl rand -hex 24` and store it in your
secret manager of choice. Rotating a key is a single environment-variable
change plus a pod restart; the legacy single-key path stays compatible with
the RBAC registry described above.

## Account settings

Profile, notification preferences, and GDPR-style data export/delete now live
at `/settings`. Try it locally:

```bash
cd web && npm run dev
# open http://localhost:7430/settings

# read current settings
curl -s http://localhost:7430/api/settings | jq

# update profile
curl -s -X PATCH http://localhost:7430/api/settings \
  -H 'content-type: application/json' \
  -d '{"profile":{"display_name":"Sanjay","email":"you@example.com","base_currency":"USD"}}' | jq

# download an account bundle (settings + runs + journal + watchlist + alerts + webhooks + batch + quota)
curl -s http://localhost:7430/api/settings/export -OJ

# permanently delete all local account data
curl -s -X POST http://localhost:7430/api/settings/delete \
  -H 'content-type: application/json' -d '{"confirm":"DELETE"}'
```

State lives in `web/.data/settings.json` alongside the other local stores.
Run the store tests with `node --experimental-strip-types --test web/tests/settingsStore.test.mjs`.

---

Not investment advice. Paper-trading and research use only. See `FINANCIAL_DISCLAIMER.md`.
