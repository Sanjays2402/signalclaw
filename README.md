# SignalClaw

A local-first time-series signal terminal that classifies market regime (bull / chop / bear / crash) and lets you save, share, comment on, and compare runs side by side.

## New: SCIM 2.0 Groups with role-mapped membership

User provisioning landed in a prior pass, but Okta and Azure AD reviewers immediately ask the next question: "can we drive role assignment from an IdP group instead of asking your operator to PATCH every user?" Without `/scim/v2/Groups` the answer was no, and the procurement loop stalled on "how do we promote the on-call engineer to admin without a console click?". SignalClaw now ships SCIM Groups with a real role binding so an IdP membership change is the only source of truth.

- `GET|POST /scim/v2/Groups` and `GET|PUT|PATCH|DELETE /scim/v2/Groups/{id}` cover the full lifecycle. Each group carries a `displayName`, an optional IdP `externalId`, and a SignalClaw role (`owner` / `admin` / `member` / `viewer`) under the `urn:signalclaw:scim:extension:1.0` extension schema. PATCH accepts both Okta's filter syntax (`members[value eq "<uid>"]` remove) and Azure AD's value-array shape (`{ op: "add", path: "members", value: [{ value: "<uid>" }] }`).
- Membership is the authoritative source for the bound API key's role. When a SCIM user is added to an admin-role group their key is promoted within the request; when removed, the highest remaining group role wins, falling back to the SCIM default role. Every reconciliation writes a `scim.group.role_reconcile` row to the tamper-evident audit chain with the before / after role, the actor (`scim:group:<displayName>`), the source IP, and the request id.
- `GET /scim/v2/ResourceTypes` now advertises Group alongside User, so an IdP introspecting the SCIM surface discovers the new resource without manual config. `ServiceProviderConfig` already declared `patch.supported = true`, which Okta requires before it will push group operations.
- Deleting a SCIM user cascades into every group they belonged to, so a deprovisioning race never leaves dangling member ids for the next reconcile loop to trip on. Deleting a group demotes every former member back to the SCIM default role before the 204 returns.
- `GET /admin/scim/groups` and the extended `GET /admin/scim/users` surface every group, every membership, and the role each user inherits, gated by the same admin scope plus admin-MFA contract as every other admin route. No new permission surface.
- `tests/test_scim.py` pins the security properties: the bearer is required on every group method, an unknown role is refused with `400 invalidValue`, a duplicate `displayName` returns `409 uniqueness`, adding and removing a user from an admin-role group flips their key's role both directions, deleting the group demotes them back to `member`, and deleting a user cleans them out of every group they belonged to.

### Try it

```bash
make dev
make api          # http://localhost:7431

# 1. mint the SCIM bearer (admin scope required)
BEARER=$(curl -fsS -X POST -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7431/admin/scim/rotate | jq -r .bearer)

# 2. provision a user (Okta / Entra style)
USER_ID=$(curl -fsS -X POST -H "authorization: Bearer $BEARER" \
  -H "content-type: application/scim+json" \
  -d '{"userName":"alice@example.com","active":true}' \
  http://localhost:7431/scim/v2/Users | jq -r .id)

# 3. create an admin-role group and put alice in it
curl -fsS -X POST -H "authorization: Bearer $BEARER" \
  -H "content-type: application/scim+json" \
  -d "{\"displayName\":\"platform-admins\",
       \"urn:signalclaw:scim:extension:1.0\":{\"role\":\"admin\"},
       \"members\":[{\"value\":\"$USER_ID\"}]}" \
  http://localhost:7431/scim/v2/Groups | jq

# alice's bound api key is now admin; remove her from the group to demote.
```

## Previously: SOC2 evidence pack at /settings/evidence-pack

Procurement reality: every enterprise security questionnaire ends with "send us evidence your controls are operating effectively". Before this change a security owner had to screenshot half a dozen admin pages, paste them into a Google Doc, attach an audit log export, and hope the reviewer trusted the screenshots. `/settings/evidence-pack` replaces that with one button that produces a deterministic, hash-manifested .zip an auditor can open and verify themselves.

- `web/lib/zipBuilder.ts` is a dep-free Node ZIP builder (stored entries, deterministic 1980 mtime, UTF-8 names) so the bundle is a real archive any unzip tool opens, not a JSON envelope we invented.
- `web/lib/evidencePack.ts` gathers the full control inventory, the audit chain replay result (proving no audit row was edited), the public key list (no secrets), the active SSO session list (no tokens), and every workspace policy (SSO, network, CORS, CSP, retention, rotation, webhook egress, residency, auth lockout, concurrency, defaults, legal holds, SIEM, freeze) into stable-sorted JSON files plus a `manifest.json` with SHA-256 of every entry. Two runs against identical inputs produce byte-identical content files so the auditor can re-verify offline.
- `GET/HEAD /api/admin/evidence-pack` is admin-gated through the shared `requireAdmin` guard, writes an audit row with the bundle SHA-256 on every download (so future reviews can prove which pack the recipient received), and stamps `X-Evidence-Pack-Sha256` and `X-Evidence-Pack-Generated-At` headers for the UI preview.
- `web/app/settings/evidence-pack/page.tsx` shows the filename, size, SHA-256 and build time before download, exposes the verification command, and is reachable from the settings nav, the admin landing surface list, and the `/admin/controls` inventory.
- `tests/evidencePack.test.mjs` parses the generated archive with a hand-rolled central-directory reader, proves every documented file is present, that every manifest hash matches the on-disk bytes inside the archive, that two consecutive builds produce identical content for every non-timestamped file, and that the control inventory exposes the new row.

### Verify the evidence pack

```bash
make dev
make web          # http://localhost:3000/settings/evidence-pack

# pull the bundle straight from curl and verify the manifest:
curl -fsS -OJ -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:3000/api/admin/evidence-pack
unzip -d pack signalclaw-evidence-*.zip
jq -r '.files[] | "\(.sha256)  \(.name)"' pack/manifest.json \
  | (cd pack && shasum -a 256 -c)
```

## Previously: Admin control inventory at /admin/controls

The admin landing tile gave a buyer five top-line numbers but no way to walk the full posture: a procurement reviewer asking "show me every security control you ship and whether it is on" had to spelunk through the settings sidebar one page at a time. `/admin/controls` is the answer: one screen, every enterprise control, with status pulled live from the same stores the individual settings pages mutate.

- `web/lib/adminIndex.ts` aggregates SSO, SCIM, admin MFA, auth lockout, SSO sessions, API keys, residency, retention, legal hold, privacy export, audit chain, API IP allowlist, CORS, CSP, webhook egress, per-key IP policy, workspace freeze, rotation deadline, concurrency cap, idempotency, SIEM sink, observability probes, and tenant isolation tests. Each row is normalized into `{key, label, href, category, status, summary}` with status drawn from the policy itself (e.g. residency in `enforce` mode reads `enforcing`, an empty CIDR allowlist on the API reads `off`, a workspace under freeze reads `enforcing`). The aggregator is framework free so it is unit tested directly against the file backed stores.
- `GET /api/admin/controls` returns the JSON inventory. Uses the existing `requireAdmin` gate so the read is audited and the same admin-MFA contract applies as on every other admin route. No new permission surface.
- `web/app/admin/controls/page.tsx` renders the inventory grouped by category (Identity, Data, Network, Operations, Observability), with a status filter, full-text search across labels and summaries, keyboard-accessible rows that deep link to the settings surface that owns the control, loading and error and empty states, and a header link from the existing `/admin` landing page so reviewers find it without being told.
- `tests/adminIndex.test.mjs` proves the full set of rows is present with non-empty labels and summaries, that flipping the workspace freeze on flips only the freeze row to `enforcing` (no collateral status drift on other rows), and that setting a retention TTL surfaces the day counts in the retention row.

### Try it

```bash
make dev
make web          # http://localhost:3000/admin/controls

# fetch the JSON inventory directly (admin scope):
curl -fsS -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:3000/api/admin/controls | jq '.counts, .controls[0:3]'
```

## Previously: API-key RBAC roles (owner / admin / member / viewer) with audited role changes

The admin console already exposed a `Role` button on every API key row, but the backend route it called did not exist, so every click 404'd and the `role` field on key listings was always blank. That is an enterprise procurement blocker: a reviewer asking "can you downgrade a leaked trading key to read-only without rotating it?" needs a real answer. This change wires RBAC roles end to end.

- `web/lib/keyStore.ts` adds a `KeyRole` (`owner` / `admin` / `member` / `viewer`) and a `roleToScopes()` map. `setKeyRole()` rewrites both `role` and the underlying `scopes` array atomically so the auth path never observes drift between the role label and the effective privileges. `createKey()` now stamps an initial role inferred from the requested scopes; admin remains unassignable via the public mint path, so the inferred role is at most `member`. `publicView()` surfaces both `role` and `effective_scopes` so the admin UI can render a stable label even for legacy keys minted before the role field existed.
- `PUT /api/admin/keys/:id/role` accepts `{ "role": "viewer" }` and is gated by admin scope plus the existing admin-MFA guard used on every other mutating admin route. Refuses to edit the env admin (rotate `SIGNALCLAW_ADMIN_KEY` instead) or revoked keys, and rejects unknown role strings with a structured `400 invalid_role`. Every accepted change writes an audit row with `role:<before>-><after>`, the source IP, and the actor key hash, so reviewers can answer "who downgraded which key, when, from where".
- `tests/keyRole.test.mjs` proves the role map, the atomic role+scope rewrite (downgrading `member` to `viewer` actually drops the `trade` scope from the stored key, blocking trade calls on the very next request), and the refusals for env-admin, revoked keys, and bogus role strings.

### Try it

```bash
make dev
make web          # http://localhost:3000/settings/keys

# downgrade a leaked trading key to read-only without rotating the secret:
curl -fsS -X PUT -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"role": "viewer"}' \
  http://localhost:3000/api/admin/keys/$KEY_ID/role | jq

# read the current role back (useful for the admin console picker):
curl -fsS -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:3000/api/admin/keys/$KEY_ID/role | jq
```

## Previously: in-place webhook edit (PATCH /webhooks/{id}) with tenant-scoped audit trail

Operators previously had two choices when a webhook needed a fix (typoed URL, noisy event filter, a paused subscription that needed resuming): delete and recreate, or leave it broken. Both are procurement red flags. Delete-and-recreate destroys the per-attempt delivery log and the secret rotation history that a SOC2 reviewer needs to reconstruct the timeline; leaving it broken means the operator stops trusting the dashboard. `PATCH /webhooks/{id}` closes that gap with a tenant-scoped, audited, SSRF-validated in-place edit.

- `PATCH /webhooks/{id}` accepts `url`, `events`, `tickers`, and `enabled` (any subset). The URL is re-run through the same SSRF destination policy used at create time so a tenant cannot pivot an existing subscription onto a private address. Event kinds are re-validated against the server-side allowlist. A non-owner key gets a flat `404` (not `403`) so cross-tenant existence does not leak; an admin-scope key can patch any subscription. Re-enabling a circuit-breaker auto-disabled subscription also clears `auto_disabled_at`, `auto_disable_reason`, and `consecutive_failures` so the next fan-out actually attempts delivery. Secret rotation is intentionally not handled here so the existing `POST /webhooks/{id}/rotate-secret` grace-window path keeps running.
- Every accepted change appends a `webhook.updated` row to the hash-chained audit log with the field-level before/after diff, the request id, the source IP, and the actor key hash, so reviewers can answer "who changed what, when, from where".
- `web/app/webhooks/page.tsx` surfaces a one-click Pause / Resume button on each subscription that calls the new PATCH endpoint and refreshes the list, keyboard-accessible and busy-state aware. The pre-existing tenant scoping on the FastAPI route means the button is safe to render for any caller.
- `tests/test_webhooks_update.py` proves owner edit + persistence, cross-tenant 404 (not 403) plus admin override, SSRF rejection leaves the row untouched, re-enable clears the circuit breaker, and unknown/empty event lists are rejected.

### Try it

```bash
make dev
make api          # http://localhost:7431
make web          # http://localhost:3000/webhooks

# pause a noisy subscription without losing its delivery log:
curl -fsS -X PATCH -H "x-api-key: $SIGNALCLAW_API_KEY" \
  -H "content-type: application/json" \
  -d '{"enabled": false}' \
  http://localhost:7431/webhooks/$SUB_ID | jq

# narrow the event filter and fix a typoed URL in one call:
curl -fsS -X PATCH -H "x-api-key: $SIGNALCLAW_API_KEY" \
  -H "content-type: application/json" \
  -d '{"url": "https://hooks.example.com/v2/signal", "events": ["entered", "exited"]}' \
  http://localhost:7431/webhooks/$SUB_ID | jq
```

## Previously: webhook circuit breaker auto-disables dead delivery endpoints

SignalClaw already retried each outbound webhook with exponential backoff, signed every payload with HMAC SHA-256, kept a per-attempt replay log, and isolated subscriptions per API key. What it did not do is stop. A receiver that returned 500 forever (DNS gone, app retired, customer firewalled us) kept burning retries and audit space on every fan-out, and a procurement reviewer had no answer to "what stops a dead endpoint from being hammered." The circuit breaker closes that gap.

- `src/signalclaw/webhooks/__init__.py` tracks `consecutive_failures` on each subscription and flips `enabled` to `false` with `auto_disabled_at` and `auto_disable_reason` after `AUTO_DISABLE_FAILURE_THRESHOLD` (5) back-to-back failed logical deliveries. Any 2xx response resets the counter and clears the auto-disable fields, so a transient blip recovers on the next success. The same path runs for both `deliver_events` and `replay_delivery` so manual replays cannot bypass the breaker.
- `POST /webhooks/{id}/reactivate` (FastAPI) clears the breaker, with the same per-tenant ownership gate used elsewhere on the `/webhooks` surface: a non-owner gets a flat 404 so cross-tenant existence does not leak, and an admin-scope key can act on any subscription. Every auto-disable, recovery, and manual reactivation appends a structured row to the hash-chained audit log (`webhook.auto_disabled`, `webhook.recovered`, `webhook.reactivated`) for SOC2 traceability.
- `WebhookOut` now ships `consecutive_failures`, `auto_disabled_at`, and `auto_disable_reason` so dashboards and the admin console can surface the breaker state without reaching into private storage.
- `tests/test_webhooks_circuit_breaker.py` proves the threshold flip, the success-resets-counter recovery path, that a non-owner cannot reactivate someone else's webhook (404, not 403), and that an admin can.

### Try it

```bash
make dev
make api          # http://localhost:7431

# inspect circuit-breaker state on your subscriptions:
curl -fsS -H "x-api-key: $SIGNALCLAW_API_KEY" http://localhost:7431/webhooks \
  | jq '.subscriptions[] | {id, url, enabled, consecutive_failures, auto_disabled_at, auto_disable_reason}'

# manually reactivate after fixing the receiver:
curl -fsS -X POST -H "x-api-key: $SIGNALCLAW_API_KEY" \
  http://localhost:7431/webhooks/$SUB_ID/reactivate | jq
```

## Previously: discoverable observability and security surface for SRE and procurement reviewers

SignalClaw already exposed `/healthz`, `/readyz`, and `/metrics` (Prometheus text exposition) from the dashboard process, propagated `X-Request-Id` through edge middleware into every audit row, and shipped settings pages for SSO, SCIM, audit, freeze, and the admin console. None of those pages were linked from `/settings`, so a buyer's security or SRE reviewer could not find them without grepping the repo. That is the difference between "we have it" and "we pass review". This change makes the surface discoverable.

- `web/app/settings/observability/page.tsx` is a new admin page that live-probes `/healthz`, `/readyz`, and `/metrics` from the browser, shows latency and HTTP status per probe, displays the `X-Request-Id` returned by the last liveness call, and renders a copy-to-clipboard Prometheus scrape config and ready-to-run `curl` commands keyed to the current origin. Loading, empty, and error states are wired for each probe card and the layout is responsive at 375px and 1440px.
- `web/app/settings/page.tsx` now links the four previously orphaned enterprise pages (SSO, SCIM, Audit log, Freeze) plus the new Observability page and the existing `/admin` console, so every customer-facing security feature is one click from `/settings`.
- `web/tests/settingsIndexDiscoverability.test.mjs` is a regression test that walks `web/app/settings/*/page.tsx` and fails the build if any top-level page is missing an `href` on the index, plus pins that the observability page surfaces `/healthz`, `/readyz`, `/metrics`, and the `X-Request-Id` propagation story. 443/443 web tests pass; `next build` succeeds.

### Try it

```bash
make dev
cd web && npm run dev          # http://localhost:3000

# the three SRE endpoints, unauthenticated and safe to scrape:
curl -fsS http://localhost:3000/healthz
curl -fsS http://localhost:3000/readyz
curl -fsS http://localhost:3000/metrics | head -40

# open the new console:
open http://localhost:3000/settings/observability
```

## Previously: legal hold registry for eDiscovery and regulator-ordered preservation

Enterprise procurement reviewers in financial services, healthcare, and government will not sign a contract without a documented way to suspend deletion when counsel issues a litigation hold. SignalClaw already pruned the hash-chained audit log on a 90-day window and exposed `POST /privacy/delete` for GDPR Article 17 erasure, which meant a routine compliance script could destroy evidence the operator was legally required to preserve. The new legal hold registry closes that gap end-to-end.

- `src/signalclaw/legal_hold/` is a file-backed registry (`legal-hold.json` under `<DATA_DIR>/legal_hold/`) keyed on the same 12-char actor hash the audit log already uses, so holds compose with the existing tamper-evident chain without leaking key material.
- Three admin endpoints, all gated by the `admin` scope and the existing MFA-for-admin dependency: `GET /admin/legal-hold` lists active holds, `POST /admin/legal-hold` places one (reason and optional `case_id` required, both length-validated by pydantic), and `DELETE /admin/legal-hold/{key_hash}` releases it. Both mutations append a structured `legal_hold.place` / `legal_hold.release` row to the audit log so the chain records who held what and when.
- `POST /privacy/delete` refuses with HTTP 409 `legal_hold_active` while any hold is active and returns the list of held actor hashes so the caller knows exactly what to release.
- `AuditRetentionPruner` now takes a `hold_predicate`; when truthy the daily sweep is skipped and emits `audit.retention.skipped_legal_hold`. The predicate fails closed: if the registry call raises, the sweep aborts rather than risk deleting preserved evidence.
- `tests/test_legal_hold.py` proves the lifecycle, the admin-scope gate, that `/privacy/delete` returns 409 while held and resumes after release, and that the retention pruner preserves files synchronously while a hold is active.

### Try it

```bash
make dev
uvicorn signalclaw.api:create_app --factory --port 8000

# place a hold (admin scope + MFA gate apply in production)
curl -s -X POST -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"key_hash":"abc123def456","reason":"SEC subpoena SC-2026-1138","case_id":"SC-2026-1138"}' \
  http://localhost:8000/admin/legal-hold | jq

# deletion is now refused
curl -s -X POST -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  'http://localhost:8000/privacy/delete?confirm=DELETE' | jq
# => {"detail":{"error":"legal_hold_active","holds":["abc123def456"],...}}

# release when counsel clears the matter
curl -s -X DELETE -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:8000/admin/legal-hold/abc123def456 | jq
```

## Previously: audit-log anomaly detector for the admin console

The append-only audit log already captures every mutating call with a hash-chained `prev_hash`/`entry_hash` pair, but a security reviewer still had to eyeball thousands of rows to spot a credential-stuffing burst or an out-of-hours admin mutation. `GET /audit/anomalies` runs four detectors directly over the live log and returns a sorted findings list the admin console renders inline on `settings/audit`.

- `auth_burst`: many `401`/`403` rows from one source IP inside the window.
- `key_burst`: same volume of denied calls pivoted by API key hash, catches credentials being abused even when the attacker rotates IPs.
- `key_ip_fanout`: one API key seen from many distinct non-loopback IPs (credential sharing or exfil).
- `offhours_admin`: a successful admin `PUT`/`POST`/`DELETE` outside the configured business-hours window in UTC.
- All thresholds are query params with safe clamps; the endpoint requires the `admin` scope and the MFA gate that already guards `/audit`. Every finding carries the contributing `request_id`s so an operator can pivot straight into the existing audit search filters.
- `tests/test_audit_anomalies.py` proves the burst, fan-out, and off-hours detectors fire on the expected fixtures and that read-only keys are denied with 403.

### Try it

```bash
make dev
uvicorn signalclaw.api:create_app --factory --port 8000

curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  'http://localhost:8000/audit/anomalies?window_min=60' | jq
# => {"window_min":60,"scanned":42,"findings":[{"kind":"auth_burst","severity":"high",...}]}
```

Open `http://localhost:7430/settings/audit` to see the anomalies card above the filters; pick a window (15m / 1h / 4h / 24h) and rescan.

## Previously: caller-facing /usage/me self-service billing surface

Every customer dashboard needs to render "you have used N of M calls this month, resets at X" without granting the dashboard an admin scope or exposing other tenants' usage. Procurement reviewers also expect a documented self-service endpoint so customers can reconcile invoices without filing a support ticket.

- `GET /usage/me` (requires only a valid `x-api-key`) returns the caller's `plan`, `current_month`, `used`, `remaining`, `reset_at`, `reset_in_seconds`, and per-month `history`.
- The lookup key is derived strictly from the presented `x-api-key`. Query params and body fields cannot redirect the lookup to another tenant, so the surface is safe to expose to first-party dashboards.
- Added to the quota middleware exempt list so polling the endpoint does not consume the quota it reports on.
- `tests/test_usage_me.py` proves cross-tenant isolation (key A's poll shows only key A's counter even when spoofing `?key_id=`), that anonymous callers are rejected, and that self-polling is free.

### Try it

```bash
make dev
uvicorn signalclaw.api:create_app --factory --port 8000

curl -s -H "x-api-key: $SIGNALCLAW_API_KEY" http://localhost:8000/usage/me | jq
# => {"key_id":"key:...","plan":{"id":"free",...},"used":3,"remaining":2,"reset_at":"...Z",...}
```

## Previously: per-API-key tenant scoping on the /v1/runs read surface

Mutating runs via `/api/v1/runs*` already enforced per-key ownership (see `decideRunMutation` in `lib/runAcl.ts`), but every `read` or `admin` key could list, fetch, export, and download the PDF of every other tenant's run on the same install. `queryRuns` returned a global view and the GET-by-id handler had no ownership check at all. Procurement flagged this as a hard cross-tenant data leak because saved runs carry the customer's full price series and notes.

- `lib/runAcl.ts` adds `decideRunRead` (mirrors `decideRunMutation`) and `ownerFilterForKey` so routes share one policy: admin keys see everything, other keys see only runs they created, plus legacy/dashboard rows that have no `created_by_key_id`.
- `lib/runStore.ts` `queryRuns` accepts `ownerFilter` and applies it before search filters, so `total` reflects the caller's tenant view and never leaks counts from sibling tenants. Internal callers (digest, watches, cron) keep the un-filtered behavior by omitting the option.
- `GET /api/v1/runs`, `GET /api/v1/runs/export`, `GET /api/v1/runs/:id`, `GET /api/v1/runs/:id/export`, `GET /api/v1/runs/:id/pdf`, and `DELETE /api/v1/runs/:id` all run through the new ACL. Denials are translated to HTTP 404 (not 403) so a probing client cannot enumerate sibling tenant ids; the audit log still captures the real reason as `forbidden:not_owner` for the operator.
- The cookie-session dashboard (`/api/runs/*`) and public share pages (`/r/:id`, OG image, share-PDF) are intentionally unchanged: those are operator-local and shareable by design.
- `tests/runReadTenantIsolation.test.mjs` pins the policy: cross-tenant list returns only the caller's rows, totals exclude foreign tenants, admin sees everything, legacy unowned rows stay readable, and non-owner reads translate to denial (route maps to 404).
### Try it

```bash
cd web && pnpm dev    # http://localhost:7430

# Mint two keys.
export ADMIN=$SIGNALCLAW_ADMIN_KEY
A=$(curl -s -X POST -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"label":"tenant-a","scopes":["read","trade"]}' \
  http://localhost:7430/api/admin/keys | jq -r .secret)
B=$(curl -s -X POST -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d '{"label":"tenant-b","scopes":["read","trade"]}' \
  http://localhost:7430/api/admin/keys | jq -r .secret)

# Tenant A saves a run.
RUN=$(curl -s -X POST -H "Authorization: Bearer $A" -H 'content-type: application/json' \
  -d '{"ticker":"AAPL","close":[100,101,102,103,104,105,106,107,108,109,110]}' \
  http://localhost:7430/api/v1/runs | jq -r .id)

# Tenant B cannot see it.
curl -s -H "Authorization: Bearer $B" http://localhost:7430/api/v1/runs | jq '.total'
# => 0
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $B" "http://localhost:7430/api/v1/runs/$RUN"
# => 404
```


## Previously: tamper-evident audit log with /audit/verify

The Python backend audit log was append-only JSONL but had no integrity binding between rows, so a privileged operator with disk access could quietly edit a past entry without anyone being able to prove it. Procurement reviewers (SOC2 CC7.2, ISO 27001 A.12.4) want on-demand evidence that the audit trail has not been altered. Every persisted audit row now carries `prev_hash` and `entry_hash` fields forming a sha256 chain, and a new admin endpoint recomputes the chain across the requested window and reports the first break.

- `AuditEvent` gained `prev_hash` and `entry_hash`. `entry_hash = sha256(prev_hash + canonical_body_json)` where the body is the row with the two hash fields removed, so re-verification is a pure function of the on-disk JSONL.
- `AuditLog.record` resolves the previous chain head from a `.chain-state` file (or reconstructs it from the newest daily JSONL on first run) and writes the new row with both fields. The chain head is updated atomically with each write under the existing log lock.
- New `GENESIS_HASH` constant (64 zero hex chars) anchors the first ever entry.
- New `AuditLog.verify(days_back)` walks daily files in chronological order, recomputes every `entry_hash`, validates each `prev_hash` against the previous entry, and returns `{ok, checked, mismatches:[...], head, days_back, files}`. Mismatch entries include `{file, line, reason, expected, actual}` so an auditor can jump straight to the tampered row.
- New `GET /audit/verify?days_back=N` admin endpoint (admin scope + MFA, same as `/audit`) exposes the verifier. Bounded to 1..365 days.
- CSV export now carries `prev_hash` and `entry_hash` columns so a SIEM can re-verify after ingest.
- `tests/test_audit_hash_chain.py` proves: the first row anchors to genesis, every row chains forward, mutating any persisted row's body is detected with the exact file + line, and the endpoint refuses non-admin callers while returning a clean report for admins.

### Try it

```bash
make dev         # installs into .venv
uvicorn signalclaw.api:create_app --factory --port 8000

# Trigger a few audited writes, then verify the chain.
curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  -X POST -H 'content-type: application/json' \
  -d '{"label":"ops","scopes":["read"]}' \
  http://localhost:8000/admin/keys

curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:8000/audit/verify?days_back=7 | jq
# => {"ok": true, "checked": N, "mismatches": [], "head": "<sha256>", ...}

# Now tamper: edit any past row's path field in data/audit/audit-YYYY-MM-DD.jsonl,
# rerun the call, and the response flips to ok=false with the offending
# file + line and the recomputed expected hash for an auditor.
```

## Previously: per-API-key alert multi-tenancy

The web `alertStore` was a single flat list shared across every API key, so an alert armed by one tenant was visible to and deletable by every other tenant hitting the same install. The `/api/v1/alerts*` route comments even said the quiet part out loud: "scope filtering is by ownership of the key, not the alert." Procurement flagged this as a hard multi-tenancy finding because alerts also drive notifier deliveries.

- `alertStore` now persists one bucket per `StoredKey.id` under `tenants[owner_key_id]`. The legacy `{ alerts, history }` payload migrates into the operator bucket on first read so single-tenant installs upgrade in place.
- `GET / POST /api/v1/alerts`, `DELETE /api/v1/alerts/:id`, and `POST /api/v1/alerts/check` resolve the caller via the existing `authenticate(extractKey(req))` path and route every read, write, and runCheck through that tenant bucket.
- New `GET /api/admin/alerts` (admin scope + MFA) exposes counts only per tenant for ops audits: `{ tenants: [{ owner_id, alert_count, armed, history_count }], total_alerts, total_history }`. Raw alert rows are never returned.
- New `/settings/alerts-tenants` admin page renders the aggregate.
- `tests/alertTenantIsolation.test.mjs` pins the policy: cross-tenant reads invisible, cross-tenant delete is a no-op, runCheck only sees the caller's alerts, clearHistory only clears the caller's bucket, admin aggregate omits row contents, and the legacy file shape migrates into the operator bucket.

### Try it

```bash
cd web && pnpm dev    # http://localhost:7430

# Mint two keys, prove isolation.
A=$(curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"label":"tenant-a","scopes":["read","trade"]}' \
  http://localhost:7430/api/admin/keys | jq -r .secret)
B=$(curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"label":"tenant-b","scopes":["read","trade"]}' \
  http://localhost:7430/api/admin/keys | jq -r .secret)

curl -s -X POST -H "Authorization: Bearer $A" -H 'content-type: application/json' \
  -d '{"ticker":"AAPL","condition":"price_above","value":200}' \
  http://localhost:7430/api/v1/alerts

curl -s -H "Authorization: Bearer $B" http://localhost:7430/api/v1/alerts | jq
# => { alerts: [], total: 0, ... }   no cross-tenant leakage

curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/alerts | jq
# => per-tenant counts only, raw alerts never exposed
```

## Previously: SIEM-ready NDJSON export of the tamper-evident audit log

The `/api/audit/export.csv` flow has always been good enough for a procurement spreadsheet, but Splunk / Datadog / Elastic ingest pipelines need the full structured event, not a flattened CSV row. The new NDJSON export streams the complete audit record per line, including the `details` JSON object and the `prev_hash` + `hash` chain fields, so an enterprise SOC can re-verify chain integrity after import. The export itself is appended to the audit chain as `GET /api/audit/export.jsonl`, capturing who pulled what.

- `GET /api/audit/export.jsonl` streams matching events as NDJSON. Same filters as `/api/audit` (`key_id`, `method`, `route`, `ok`, `since`, `limit`). Default cap 100k rows; max 1M. Sends `Content-Type: application/x-ndjson` and an `x-signalclaw-audit-format: ndjson;chain=hmac-sha256` hint for SIEM-side verifiers.
- Bypasses the 1000-row UI cap on `queryAudit`, so a full workspace can be exfiltrated to the buyer's log lake in one request without paging.
- Admin-scoped when `SIGNALCLAW_ADMIN_KEY` is set; mirrors local-mode behavior otherwise. Denials are audited with `reason: "forbidden:admin-required"`.
- New `streamAuditFiltered()` helper in `lib/auditStore.ts` is unit-tested for newest-first ordering, predicate correctness, full event shape (chain fields preserved), and the 1000-row cap bypass.
- UI surface: `/settings/audit` gained an `Export JSONL` button next to the existing CSV button. Same filters apply.

### Try it

```bash
cd web && pnpm dev    # http://localhost:7430

# Pull every audited event from the last 24h as NDJSON.
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:7430/api/audit/export.jsonl?since=$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)" \
  -o audit.jsonl
wc -l audit.jsonl

# Each line is a full event including the hash chain.
head -1 audit.jsonl | jq '{ts, route, method, status, key_id, prev_hash, hash}'
```

## Earlier: per-API-key watchlist multi-tenancy

The Python `/watchlist`, `/picks`, and `/report.md` endpoints used to share one universe across every API key in a deployment, which meant a ticker added by one customer was visible to and removable by every other customer hitting the same backend. Procurement reviewers flagged this as a hard multi-tenancy finding because the watchlist also drives the daily report and the regime classifier output, so cross-tenant leakage at the universe layer also leaked downstream model output. SignalClaw now stores one watchlist per user-managed API key (`StoredKey.id`), seeded from the default universe on first read, and the legacy operator key keeps the original bucket so single-tenant installs upgrade in place. A new admin route exposes the aggregate view for ops.

- `GET/POST/DELETE /watchlist` scope reads and writes to the calling key's tenant bucket.
- `GET /picks` and `GET /report.md` score the caller's own watchlist, not the global one.
- `GET /admin/watchlists` (admin scope + MFA) returns `{tenants: {key_id: [tickers]}}` so an operator can audit every tenant from one surface. The in-app console exposes the same data at `/admin/watchlists` (linked from the admin landing page) with a tenant/ticker filter so a security reviewer can answer "who tracks what" without curl.
- Mutations flow through the existing `AuditMiddleware`, so every add and remove lands in the tamper-evident audit chain with the actor key id.
- `tests/test_watchlist_tenant_isolation.py` pins the policy: cross-tenant reads invisible, cross-tenant deletes no-op, admin aggregate sees every tenant.

### Try it

```bash
# Two member keys minted from POST /admin/keys.
export ALICE=sk_alice...
export BOB=sk_bob...

curl -s -X POST http://localhost:7431/watchlist \
  -H "x-api-key: $ALICE" -H "content-type: application/json" \
  -d '{"ticker":"NVDA"}'

# Bob does not see NVDA in his own list.
curl -s http://localhost:7431/watchlist -H "x-api-key: $BOB" | jq .

# Admin aggregate view.
curl -s http://localhost:7431/admin/watchlists -H "x-api-key: $ADMIN_KEY" | jq .
```

## Previously: per-run RBAC ownership on /api/v1/runs

Procurement reality: any team that issues more than one API key for SignalClaw eventually asks the obvious question: can a `trade`-scoped key delete or rename a run that a different `trade`-scoped key created? Until now the answer was yes, which fails the SOC2 "least privilege" review the first time a buyer asks. SignalClaw now stamps every run created through `POST /api/v1/runs` with the api key id and label of its creator, and mutating routes under `/api/v1/runs/:id` enforce per-key ownership. A `trade` key can only delete or modify runs it created. The `admin` scope still bypasses ownership for operational recovery, and legacy unowned runs (created before this shipped, or via the local dashboard) remain mutable for back-compat.

- `POST /api/v1/runs` stamps `created_by_key_id` and `created_by_key_label` on the new row.
- `GET /api/v1/runs` and `GET /api/v1/runs/:id` return an `owner` object so callers and the dashboard can render attribution.
- `DELETE /api/v1/runs/:id` returns `403 forbidden:not_owner` when a different `trade` key tries to delete an owned run. The denial is appended to the tamper-evident audit chain with the actor key id, the target run id, and the real owner key id, so an admin can reconstruct who tried to touch what.
- The history page (`/history`) renders the owning api key label next to each run so an operator can spot cross-key writes at a glance.
- `tests/runAcl.test.mjs` pins the policy: owner allowed, cross-key denied, admin bypasses, legacy unowned mutable.

### Try it

```bash
# Two trade-scoped keys minted from /settings/keys.
export ALICE=sk_live_alice...
export BOB=sk_live_bob...

# Alice creates a run.
RUN_ID=$(curl -s -X POST http://localhost:7430/api/v1/runs \
  -H "Authorization: Bearer $ALICE" \
  -H "content-type: application/json" \
  -d '{"ticker":"SPY","close":[470,471,472,473,474,475,476,477,478,479,480,481,482,483,484,486,487,488,489,490,491,492,493,494,495,496,497,498,499,500,501,502]}' | jq -r .id)

# Bob tries to delete it: 403 forbidden:not_owner.
curl -s -X DELETE -H "Authorization: Bearer $BOB" \
  http://localhost:7430/api/v1/runs/$RUN_ID | jq .

# Alice deletes her own run: 200.
curl -s -X DELETE -H "Authorization: Bearer $ALICE" \
  http://localhost:7430/api/v1/runs/$RUN_ID | jq .
```

UI: visit http://localhost:7430/history to see the `api: <key-label>` attribution under each row.

## Previously: SCIM 2.0 lifecycle provisioning for Okta, Azure AD, and Google Workspace

Procurement reality: any enterprise above a few dozen seats refuses to manage dashboard access by hand. Once SSO works, the buyer's IT team asks for SCIM 2.0 so Okta or Azure AD can push joiners and pull leavers automatically. Without `/scim/v2` the procurement review stalls on "how do we deprovision a terminated employee in under five minutes?". SignalClaw now ships an RFC 7644 subset that covers what those IdPs actually exercise: bearer-token auth, `ServiceProviderConfig` discovery, full User CRUD, PATCH with both Okta path-based and Azure AD value-shape semantics, and `userName eq` filtering.

- `GET /scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` advertise the surface so an IdP can introspect before the first push.
- `GET|POST /scim/v2/Users` and `GET|PUT|PATCH|DELETE /scim/v2/Users/{id}` cover the full lifecycle. PATCH accepts both `{ op: "replace", path: "active", value: false }` (Okta) and `{ op: "Replace", value: { active: false } }` (Azure AD).
- Auth is a single workspace-wide bearer minted from Settings, hashed at rest, with `last_used_at` stamped on every accepted call so an operator can detect a stale IdP connector.
- `GET|POST|DELETE /api/admin/scim` lets an admin inspect, rotate, or revoke the bearer. The plaintext is shown exactly once at rotation; rotating invalidates the previous token immediately. Every mutation is appended to the tamper-evident audit chain.
- Settings UI at `/settings/scim` shows the token status, the IdP endpoint base URL, and a read-only table of every provisioned user with active flag and last-modified timestamp. The admin console landing page links into it.
- `tests/scimStore.test.mjs` pins the security properties: an unconfigured store rejects every token, rotation invalidates prior credentials, duplicate `userName` is refused with `scimType: uniqueness`, and PATCH handles both IdP dialects.

### Try it

```bash
# Mint the bearer token (returned once).
curl -s -X POST -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/scim | jq .

# Use the bearer the IdP would use.
export SCIM_TOKEN=scim_live_...

# Discovery (no auth required).
curl -s http://localhost:7430/scim/v2/ServiceProviderConfig | jq .

# Push a user (Okta-style POST).
curl -s -X POST -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "content-type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"alice@example.com","name":{"givenName":"Alice","familyName":"Lee"},"active":true}' \
  http://localhost:7430/scim/v2/Users | jq .

# Suspend (Azure AD value-shape).
curl -s -X PATCH -H "Authorization: Bearer $SCIM_TOKEN" \
  -H "content-type: application/scim+json" \
  -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","value":{"active":false}}]}' \
  http://localhost:7430/scim/v2/Users/<id> | jq .
```

UI: visit http://localhost:7430/settings/scim to mint the bearer and audit who has been provisioned.

## Previously: per-workspace concurrent request limit

Procurement reality: per-minute rate limits and monthly quotas do not stop a single misbehaving client from opening dozens of long-running inference requests at once and starving every other service that shares the workspace key. SOC2 capacity-planning reviewers ask for a noisy-neighbour control specifically. SignalClaw now ships a workspace-wide cap on the number of in-flight `/api/v1/*` requests, enforced inside `v1Guard` after rate limits and quotas. When the cap is hit, new requests are rejected with `HTTP 429 workspace_concurrency_exceeded`, `Retry-After: 1`, and `x-concurrency-limit` / `x-concurrency-in-flight` headers so well-behaved clients self-throttle. Every successful v1 response also carries those headers so dashboards can graph utilisation in real time.

- `GET /api/admin/concurrency` returns the live policy and the current in-flight gauge.
- `PUT /api/admin/concurrency` with `{ "limit": <int 1..10000> }` sets the cap. Admin scope plus admin MFA. Audited with before/after.
- `DELETE /api/admin/concurrency` removes the cap. Per-key rate limit and monthly quota still apply.
- Enforcement lives in `lib/v1Guard.ts` and uses `tryAcquire` / `release` from `lib/concurrencyStore.ts`. A `try/finally` around the handler prevents slot leaks on thrown errors.
- Settings UI at `/settings/concurrency` shows live in-flight, a utilisation bar, last-changed actor and timestamp, and Set / Update / Remove cap actions.

### Try it

```bash
# inspect the current policy
curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/concurrency | jq .

# cap the workspace at 4 in-flight v1 requests
curl -s -X PUT -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"limit": 4}' \
  http://localhost:7430/api/admin/concurrency | jq .

# remove the cap when the incident is over
curl -s -X DELETE -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/concurrency | jq .
```

UI: visit http://localhost:7430/settings/concurrency for the live utilisation bar and the Set / Update / Remove cap controls.

## Previously: SSO session liveness, per-email filter, and a security-property test suite

Procurement reality: SOC2 reviewers do not just want "we revoke sessions"; they want "prove the revoke worked and show me last-activity per device." SignalClaw's SSO session ledger now records `last_seen_at` and a `last_seen_ip_hash` on every successful verification (throttled to one disk write per 30s per session, so the hot path stays cheap), and the admin list endpoint accepts an `?email=` filter so an operator can answer "which devices does Alice have signed in right now?" in one request. Raw IPs are never persisted at any point in this path; only SHA-256 hashes.

- `GET /api/admin/sessions?email=alice@example.com` returns just that user's rows. Combine with `?include_revoked=1` to see what was killed yesterday and by whom.
- Every authenticated admin gate (`lib/adminGuardCore.ts`) now passes the caller IP into `verifySessionCookie`, which forwards it to the registry's throttled liveness updater. No schema migration is required; new fields default to `null` for sessions minted before the upgrade.
- Settings → SSO sessions (`/settings/sessions`) shows a per-row `last seen Nm ago` line next to the `signed in Nh ago` line, plus an email filter input that round-trips through the new query parameter.
- `tests/ssoSessionRegistry.test.mjs` pins the security properties an enterprise buyer cares about: a revoked session fails verification on the very next call, an offboarding-by-email kills every other session for that address while leaving every other user untouched, a global epoch bump invalidates every existing cookie at once, and a cookie without a known jti is rejected even when its HMAC signature is valid (no forged-but-otherwise-legal token can pass).

Try it locally:

```bash
# Active sessions for one user, including any revoked rows.
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:7430/api/admin/sessions?email=alice@example.com&include_revoked=1"

# Revoke one device by jti (idempotent, audited).
curl -fsSL -X DELETE \
  -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"reason":"lost laptop"}' \
  http://localhost:7430/api/admin/sessions/JTI_HERE
```

## Previously: Admin console (single-pane workspace posture)

Procurement reality: a security reviewer opening SignalClaw for the first time should be able to answer "who has access, is the audit log intact, what failed in the last 24h" in under a minute, without crawling fifteen sub-pages. SignalClaw already shipped every individual admin surface (keys, SSO, sessions, MFA, invites, webhooks, CORS, CSP, network policy, retention, legal hold, SIEM, privacy, freeze) but the workspace lacked a landing page that stitched them together. The new `/admin` console fixes that. It is a single guarded snapshot rendered from one round trip, with deep links into every surface that owns each tile.

- `GET /api/admin/overview?recent=25` returns the workspace posture in one shot: API key counts (active / revoked / expired / admin-scoped / suspended), audit chain integrity (HMAC chain verified, `ok` plus the break index and reason on failure), the 24h audit window (total audited calls and denied calls), seat usage, SSO state (enabled, enforce, allowed domains), admin mode (`local` vs `production`), and the last N audit events.
- The route is gated by the shared `requireAdmin` helper, so the same admin-key + SSO-session + admin-MFA rules that protect every other `/api/admin/*` surface apply identically here, and every call (allowed or denied) is written to the tamper-evident audit chain.
- `/admin` is the Linear-style console page: posture tiles, audit chain status card, an admin surfaces index, and a recent audited activity table that refreshes every 30 seconds. Settings now links straight to it.
- `tests/adminOverview.test.mjs` pins the contract: the snapshot reflects newly minted and revoked keys live, a read-scope key is denied admin with `forbidden:admin-required`, an anonymous caller is denied, and the env admin key is allowed.

Try it locally:

```bash
# 1. Local mode (no SIGNALCLAW_ADMIN_KEY set): open the console directly.
#    http://localhost:3000/admin

# 2. Production posture: gate the call with the admin key.
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:3000/api/admin/overview?recent=10" | jq '{keys, audit_chain, audit_window, seats, sso, admin_mode}'

# 3. Confirm a denial is audited.
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer sc_live_not_an_admin" \
  "http://localhost:3000/api/admin/overview"
# 403
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:3000/api/v1/audit?limit=5" | jq '.events[0] | {route, status, reason}'
```

## Previously: OIDC Single Sign-On for the dashboard (Google Workspace, Okta, Azure AD)

Procurement reality: every enterprise buyer above ~50 seats requires the dashboard to federate sign-in against their IdP. Without it the security questionnaire stalls at "how do offboarded employees lose access?" — a per-user API key is not an answer. SignalClaw now ships a real OpenID Connect Authorization Code + PKCE flow that works with any spec-compliant IdP (Google Workspace, Okta, Microsoft Entra ID / Azure AD, Auth0, Keycloak), with a workspace email-domain allowlist and an Enforce SSO toggle for browser sessions. Machine-to-machine API keys with the `admin` scope continue to work so CI and cron never get locked out by a policy flip.

- `GET /api/admin/sso` and `PUT /api/admin/sso` (admin scope, admin MFA on write) manage the workspace policy: issuer, client id, client secret, redirect URI override, allowed email domains, enabled, enforce. PUT live-probes the OIDC Discovery document before saving so a typo cannot be persisted.
- `GET /api/auth/sso/login?return_to=/settings` starts the flow. State, nonce, and the PKCE verifier are stashed in a short-lived HMAC-signed transaction cookie so the callback can verify them without a server-side session store.
- `GET /api/auth/sso/callback` exchanges the code at the IdP token endpoint with PKCE, fetches the JWKS, verifies the ID token signature (RS256 or ES256) plus `iss` / `aud` / `exp` / `nonce` / `email_verified`, enforces the domain allowlist, and sets an HttpOnly + SameSite=Lax + Secure (when HTTPS) session cookie. Every branch — bad state, expired tx, IdP error, token-exchange failure, signature failure, wrong domain, success — writes a tamper-evident audit-log line.
- `GET|POST /api/auth/sso/logout` clears the session cookie and the tx cookie.
- The admin gate (`lib/adminGuardCore.ts`) now accepts SSO sessions as an admin identity in addition to admin keys. With Enforce SSO on, anonymous browser sessions get `403 forbidden:sso-required`; the admin API-key path stays open for CI.
- Settings → SSO (`/settings/sso`) is the Linear-style UI for configuring the provider, allowlist, enable, enforce, plus a Test sign-in / Sign out button pair.

Try it locally:

```bash
# 1. Configure the policy (Google Workspace example).
curl -fsSL -X PUT \
  -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"enforce":false,"issuer":"https://accounts.google.com","client_id":"YOUR_CLIENT_ID.apps.googleusercontent.com","client_secret":"YOUR_SECRET","allowed_domains":["yourcompany.com"]}' \
  http://localhost:7430/api/admin/sso

# 2. Open the browser-facing login in your IdP redirect-uri allowlist:
#    http://localhost:7430/api/auth/sso/callback
# 3. Click Test sign-in on /settings/sso, complete the IdP prompt, land back on the dashboard.
# 4. Inspect the audit trail.
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:7430/api/v1/audit?limit=10"
```

`tests/sso.test.mjs` pins the security properties: HMAC-signed cookies reject every single-bit tamper, tx cookies refuse session-signed bodies, `verifyIdToken` rejects wrong nonce / wrong issuer / wrong audience / expired / mutated signature, the admin gate accepts a valid session whose email domain is allowlisted, denies one outside the allowlist with `forbidden:sso-domain`, and refuses anonymous browser sessions when Enforce SSO is on.

## Previously: API key expiry watch (rotate before automation breaks)

Procurement reality: enterprise security policies mandate time-bound credentials, and SOC2 CC6.1 expects evidence that credentials are reviewed on a cadence. SignalClaw has supported per-key `expires_at` for a while; what was missing was a place to ask "what is about to lapse" without grepping the keys JSON. The new admin endpoint and settings banner make that visible at a glance, with the same audit and admin-key gating as the rest of `/api/admin/*`. The watch list always surfaces already-expired keys even outside the window, so a dead credential still wired into a downstream job cannot hide.

### Try it

Local URL: http://localhost:3000/settings/keys (banner appears once any key has an `expires_at`).

```bash
# Window defaults to 30 days; bump it for a longer-horizon roster.
curl -s "http://localhost:3000/api/admin/keys/expiring?within_days=14" \
  -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" | jq .counts
# { "expired": 0, "critical": 1, "soon": 2, "upcoming": 4, ... }
```

In local single-user mode (no `SIGNALCLAW_ADMIN_KEY` env) the endpoint is open and the request is audited as `local-mode`. In production posture an admin-scoped key is required; missing or under-scoped requests get a 403 and a `forbidden:admin-required` audit line.

## Previously: GDPR self-service via the v1 API (export + erase)

Procurement reality: every EU and UK customer asks how a data subject can exercise their GDPR rights without filing a ticket. Admin-only privacy buttons are not enough; reviewers want a documented programmatic surface so DSAR handling can sit inside the customer's own pipeline. SignalClaw now exposes the same export + erase machinery the admin console uses as two v1 endpoints, with the existing rate limits, audit logging, scope checks, and legal-hold respect already in place.

- `GET /api/v1/privacy/export` returns a GDPR Article 15 + 20 data bundle. Any key with `read` scope is accepted, since access is a data-subject right, not an operator privilege. The bundle ships as a downloadable attachment.
- `GET /api/v1/privacy/erase` returns the dry-run plan (`willRemove` + `willPreserve`) so a client can preview the impact before posting.
- `POST /api/v1/privacy/erase` executes the erase. Admin scope is required, dry-run is the default, and execution needs an explicit `{ "confirm": "DELETE", "dry_run": false }`. An open legal hold returns 409 with the active matter list.

Every call is rate limited per key, written to the tamper-evident audit log with `privacy.export`, `privacy.erase.preview`, `privacy.erase.executed`, or `privacy.erase.blocked_by_legal_hold`, and surfaced in the OpenAPI spec at `/api/v1/openapi.json`. The Settings → Privacy page now ships a copy-pasteable curl block alongside the existing buttons so customers can wire DSAR handling straight into their own runbooks.

Try it locally:

```bash
# Export your workspace data (read scope is enough)
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_KEY" \
  -o signalclaw-export.json \
  http://localhost:7430/api/v1/privacy/export

# Preview an erase, no side effects
curl -fsSL -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/v1/privacy/erase

# Execute the erase (admin scope + confirm + dry_run:false)
curl -fsSL -X POST \
  -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"confirm":"DELETE","dry_run":false}' \
  http://localhost:7430/api/v1/privacy/erase
```

The scope boundary is locked down in `tests/v1Privacy.test.mjs`: a read-only key can pull an export but cannot pass the admin gate on erase, `createKey` never grants admin scope through the public input shape, dry-run plans never mutate files, and the confirm-token truth table forces an explicit `{"confirm":"DELETE","dry_run":false}` before anything is deleted.

## Previously: SCIM 2.0 user provisioning for Okta, Entra, and Google Workspace

Procurement reality: every enterprise security review asks whether joiner / mover / leaver is automated against the customer's identity provider. SAML or OIDC alone solves login, not the lifecycle. SCIM 2.0 (RFC 7643 / 7644) is the wire protocol Okta, Microsoft Entra ID, Google Workspace, OneLogin and JumpCloud all speak for that lifecycle, which is why SOC2 CC6.2 and ISO 27001 A.9.2 expect it. SignalClaw now ships a real SCIM 2.0 `/Users` implementation that mints a SignalClaw API key when the IdP creates a user, hard-revokes the key the moment the IdP marks them inactive or deleted, and writes every step to the existing tamper-evident audit log.

The full lifecycle is wired end to end:

- `POST /admin/scim/rotate` mints a rotatable bearer token (admin scope + MFA). The plaintext is shown exactly once; only its SHA-256 hash is persisted.
- `GET  /scim/v2/ServiceProviderConfig` and `/scim/v2/ResourceTypes` advertise the supported feature set so an IdP connector can discover the integration.
- `POST /scim/v2/Users` accepts the SCIM `User` schema, mints a SignalClaw API key bound to the IdP `userName` / `externalId`, and returns the secret once via the `urn:signalclaw:scim:extension:1.0` extension.
- `PUT`, `PATCH /scim/v2/Users/{id}` honor the `active` flag exactly: deactivation hard-revokes the bound key within the same request; reactivation mints a fresh key (the old secret stays dead).
- `DELETE /scim/v2/Users/{id}` revokes the bound key and removes the SCIM row.
- `GET /scim/v2/Users?filter=userName eq "..."` supports the only filter Okta and Entra actually send.
- `GET /admin/scim/users` surfaces the SCIM roster to the admin console without leaking secrets, and `PUT /admin/scim/policy` controls the default role and scopes minted on provision.

Every mutation is written to the existing audit log with the SCIM `id`, the IdP-supplied `externalId`, and the bound `key_id` so a reviewer can trace a deprovision back to the source-of-truth ticket. The bearer is constant-time compared, never logged, and disabling SCIM (`POST /admin/scim/disable`) takes effect instantly.

Try it locally:

```bash
# 1. Mint a SCIM bearer (admin scope + TOTP required)
curl -s -X POST -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
     -H "x-mfa-code: 123456" \
     http://localhost:7431/admin/scim/rotate | jq .
# => {"enabled": true, "bearer": "scim_...", ...}

export SCIM="scim_xxx"  # paste the bearer once

# 2. Provision a user the way Okta does
curl -s -X POST -H "Authorization: Bearer $SCIM" \
     -H "content-type: application/scim+json" \
     -d '{
       "schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],
       "userName":"alice@example.com",
       "displayName":"Alice Example",
       "externalId":"okta-abc-123",
       "active":true,
       "emails":[{"value":"alice@example.com","primary":true,"type":"work"}]
     }' \
     http://localhost:7431/scim/v2/Users | jq .
# => {"id":"...","active":true,"urn:signalclaw:scim:extension:1.0":{"apiKeySecret":"sck_..."}}

# 3. Deprovision (Okta sends this when a leaver hits the IdP)
curl -s -X PATCH -H "Authorization: Bearer $SCIM" \
     -H "content-type: application/scim+json" \
     -d '{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
          "Operations":[{"op":"replace","value":{"active":false}}]}' \
     http://localhost:7431/scim/v2/Users/$USER_ID | jq .
# The bound API key is dead from this moment on.
```

Correctness is enforced at the wire: `tests/test_scim.py` proves the endpoint is 404 until a bearer is minted, that every method returns 401 without `Authorization: Bearer ...`, that a wrong bearer is rejected, that creating a user produces an API key which actually authenticates a read call, that PATCH `active=false` revokes that key on the next request, that reactivation issues a fresh secret different from the original, that DELETE removes the user and kills the key, and that `scim.user.create`, `scim.user.deactivate`, `scim.user.reactivate`, and `scim.user.delete` all appear in the audit log.

## Previously: legal hold suspends retention and erase for in-scope data

Procurement reality: every regulated buyer (financial services, healthcare, public sector) requires the vendor to be able to suspend automated deletion the moment litigation, regulatory inquiry, or eDiscovery is anticipated. SOC2 CC6.5, FRCP Rule 37(e), and most master service agreements expect this control to exist before signature. SignalClaw now ships a per-workspace legal hold register that pins data while a matter is open.

An admin opens a matter at `/settings/legal-hold` with one or more scopes (`runs`, `audit`, `webhook_deliveries`, or `user_data` for everything). While the matter is active, `runRetentionSweep()` skips the held categories and reports them under `skipped`, and the privacy hard-delete at `/api/admin/privacy/delete` fails closed with `409 legal_hold_active` so no one can purge data under hold even with full admin + MFA. Opening and releasing a hold both write to the tamper-evident audit chain, and release requires a counsel reason on the record. The history view keeps every released hold so reviewers can prove exactly when each pin was in force.

Try it locally: `cd web && pnpm install && pnpm dev`, then open <http://localhost:7430/settings/legal-hold>. Or drive it from the API:

```bash
# Open a hold (admin scope + MFA required in production posture)
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"matter":"Case 24-CV-1183 (Acme v. Doe)","reason":"discovery preservation","scopes":["runs","audit"]}' \
  http://localhost:7430/api/admin/legal-hold | jq .

# List active and past holds
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/legal-hold | jq .

# Attempt to hard-delete user data while a hold is active (returns 409)
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"confirm":"DELETE"}' \
  http://localhost:7430/api/admin/privacy/delete -i | head -1

# Release the hold with a counsel reason
curl -s -X DELETE -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"released_reason":"matter closed, counsel cleared destruction"}' \
  "http://localhost:7430/api/admin/legal-hold?id=<hold-id>" | jq .
```

The retention sweep result now includes a `skipped` object naming the holds that blocked each scope, so a cron-driven sweep can alert when it could not run.

## Previously: TOTP recovery codes for admin MFA lockout recovery

Procurement reality: every enterprise security review asks the same question about MFA — "what happens when the admin loses their phone?" Without a documented escape hatch, mandatory MFA is a self-DoS waiting to happen, which is why SOC2 CC6.1, ISO 27001 A.9.4, and NIST 800-63B all require backup authenticators alongside any TOTP factor. SignalClaw now mints ten single-use recovery codes the moment an admin completes TOTP enrollment, displays them exactly once, persists only their SHA-256 hashes, and accepts any unused code via `X-MFA-Recovery-Code` on any mutating admin route covered by `lib/adminMfaGuard.ts`.

The full lifecycle is wired end to end:

- `POST /mfa/enroll` (aliased to `/api/admin/mfa/enroll`) starts a pending enrollment and returns the secret + `otpauth://` URI exactly once.
- `POST /mfa/confirm` verifies a 6-digit code, marks the enrollment confirmed, and returns the initial batch of recovery codes. Until confirm succeeds, the MFA guard treats the key as not enrolled so a half-finished enrollment cannot lock you out.
- `POST /mfa/recovery-codes/regenerate` requires a fresh TOTP code (a stolen recovery `.txt` cannot self-perpetuate) and atomically replaces the whole batch; previously saved codes stop working immediately.
- `POST /mfa/disable` accepts either a fresh TOTP code or one unused recovery code as proof of possession before clearing the enrollment.
- `GET  /mfa/status` reports `enrolled`, `pending`, and `recovery_codes_remaining` so the Security page can warn when only a few codes are left.

Every codepath writes to the tamper-evident audit chain: enrollment, confirm, regenerate, each consumed recovery code with the remaining count, and every rejection (`mfa_invalid:recovery_rejected`, `recovery-regen-reject:*`, `mfa-disable-recovery-reject`). The frontend at `/settings/security` shows the codes once with copy / download / acknowledgement gating, surfaces a running counter, and exposes a one-shot "queue a recovery code for the next admin call" panel that sets `X-MFA-Recovery-Code` exactly once and then clears the buffer.

Try it locally: `cd web && npm run dev`, then open http://localhost:7430/settings/security, scan the QR, enter a code to confirm, and save the ten recovery codes shown. Or drive it from the API:

```bash
# Begin enrollment (returns secret + otpauth URI exactly once)
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/mfa/enroll | jq .

# Confirm with the 6-digit code your authenticator shows. The response
# carries the ten recovery codes; they are never shown again.
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"code":"123456"}' \
  http://localhost:7430/mfa/confirm | jq .

# Use a recovery code in place of an authenticator code on any mutating
# admin route (the guard burns it server-side on success):
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Recovery-Code: A4F9K-PQR2X" \
  http://localhost:7430/api/admin/freeze | jq .

# Rotate the whole batch (requires a fresh TOTP code; old codes die)
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  http://localhost:7430/mfa/recovery-codes/regenerate | jq .
```

Correctness is enforced at the store: `web/tests/totpRecoveryCodes.test.mjs` proves regenerate refuses to mint until enrollment is confirmed, exactly ten canonical `XXXXX-XXXXX` codes are returned, only SHA-256 hashes ever hit `.data/totp.json`, each code burns on first use, lower-case and dash-stripped forms still match, unknown or malformed codes never decrement `recovery_codes_remaining`, and a regenerate invalidates the entire previous batch atomically with zero overlap.

## Previously: per-workspace Content Security Policy with violation logging

Procurement reality: every browser-based SaaS questionnaire asks how you ship `Content-Security-Policy`. "X-Frame-Options" plus `nosniff` cover a thin slice of browser threats. CSP is what blocks a malicious script injected through a stored XSS or a compromised CDN. SignalClaw now ships a CSP rollout flow built for that conversation.

The edge middleware reads CSP from environment (`SIGNALCLAW_CSP_MODE=off|report|enforce`, `SIGNALCLAW_CSP_EXTRA_HOSTS="cdn.example.com *.intercom.io"`, `SIGNALCLAW_CSP_REPORT_DISABLED=1` to silence reports) so the header lands on every dashboard response, including 401s and 503s. A new admin route at `/api/admin/csp` persists the per-workspace policy and shows operators when the saved policy has drifted from the env-driven effective one. Browser violations POST to `/api/csp-report`, get summarized, and write into the tamper-evident audit chain as `csp:violation` events so SOC operators can spot stored XSS attempts the moment a browser reports them. Roll out in `report`, watch `/api/v1/audit` for `csp:violation` entries, then flip to `enforce` when the report stream is quiet.

Try it locally: `cd web && pnpm install && pnpm dev`, then open <http://localhost:7430/settings/security/csp>. Or drive it from the API:

```bash
# Inspect current policy (admin scope + MFA required in production posture)
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  http://localhost:7430/api/admin/csp | jq .

# Update policy: report-only with two extra trusted hosts
curl -s -X PUT -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"mode":"report","extra_hosts":["cdn.example.com","*.intercom.io"],"reporting_enabled":true}' \
  http://localhost:7430/api/admin/csp | jq .

# Simulate a violation report (browsers do this automatically)
curl -s -X POST -H 'content-type: application/csp-report' \
  -d '{"csp-report":{"violated-directive":"script-src","blocked-uri":"https://evil.example/x.js","document-uri":"http://localhost:7430/"}}' \
  http://localhost:7430/api/csp-report -i | head -1
```

The violation lands in the audit log alongside actor, route, request id, and a hashed source IP, exportable by the existing audit endpoints.

## Previously: SIEM audit log forwarder

Procurement reality: SOC2 CC7.2 and ISO 27001 A.12.4 both require security-relevant events to leave the system in near real time so the customer's SOC can correlate SignalClaw activity with the rest of their estate (Splunk, Datadog, Elastic, Panther). The internal append-only tamper-evident audit chain at `lib/auditStore.ts` is the source of truth. The SIEM forwarder is the optional outbound mirror: every audit event is signed with HMAC-SHA256 and POSTed fire-and-forget to a configured collector URL. A failing or slow SIEM never blocks an end-user request.

Every POST carries `X-SignalClaw-Signature: sha256=<hex>` over the raw JSON body, plus `X-SignalClaw-Event-Id` and `X-SignalClaw-Timestamp` so the receiver can defend against replay. The sink supports an optional extra header (for collectors that demand a tenant token), a bounded per-request timeout (100..10000ms, default 2s), and a rolling in-memory delivery log so an operator can confirm the integration is healthy without round-tripping through the SIEM itself. A built-in test endpoint dispatches a synthetic event so you can verify your collector wired the HMAC correctly before flipping `enabled: true` in production.

Try it locally: `cd web && npm run dev`, then open http://localhost:7430/settings/siem, paste a collector URL and HMAC secret, save, and click "Send test event". Or drive it from the API:

```bash
# Configure the sink (admin scope + MFA required in production posture)
curl -s -X PUT -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"url":"https://collector.example.com/in","secret":"supersecret-very-long-1234567890","enabled":true}' \
  http://localhost:7430/api/admin/siem | jq .

# Dispatch a synthetic event to prove the receiver works
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  http://localhost:7430/api/admin/siem/test | jq .

# Inspect recent dispatch attempts
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/siem/deliveries | jq .
```

Correctness is enforced at the store: `web/tests/siemSinkStore.test.mjs` proves the HMAC matches the raw body byte-for-byte, the sink cannot be enabled without a URL and secret, disabled sinks are silent no-ops (no fetch), failed deliveries are recorded without throwing, and the public view never leaks the plaintext secret or extra header value.

## Previously: TOTP MFA on every mutating admin route

Procurement reality: a single static admin bearer token is the artifact most security reviews refuse to accept. Once the token leaks, every workspace setting from key minting to data residency to the kill switch is one curl call away. SignalClaw now requires a second factor on every mutating admin endpoint. Each admin API key can enroll a TOTP secret (RFC 6238, SHA1, 30 second step, 6 digits, Google Authenticator / 1Password / Authy compatible). Once enrolled, every `POST`, `PUT`, `PATCH`, and `DELETE` under `/api/admin/*` requires a fresh `X-MFA-Code` header. Wrong, missing, malformed, or replayed codes are rejected with `401 mfa_required` or `401 mfa_invalid` and written to the tamper-evident audit chain. Read-only `GET` calls stay un-gated so the dashboard does not nag on every render, and local single-user mode (no `SIGNALCLAW_ADMIN_KEY`) bypasses MFA so a fresh install can bootstrap.

Replay defence is real, not aspirational: the last accepted time step per key is persisted, so the same 6-digit code cannot be reused within its 30 second window. A ±1 step tolerance keeps codes that tick over mid-request from failing. Every mutating admin route on the codebase is covered, including the shared `lib/adminGuard.ts` helper used by the webhooks management surface, so future admin routes inherit the gate.

Try it locally: `cd web && npm run dev`, then open http://localhost:7430/settings/admin-mfa, scan the QR, and verify a code. Or drive it from the API:

```bash
# Status: is this key enrolled?
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/mfa | jq .

# Begin enrollment. Returns the base32 secret and otpauth:// URI exactly once.
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/mfa | jq .

# Verify the 6-digit code your authenticator app shows to complete enrollment.
curl -s -X PUT -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"code":"123456"}' \
  http://localhost:7430/api/admin/mfa | jq .

# From now on, every mutating admin call needs X-MFA-Code:
curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H "X-MFA-Code: 654321" \
  -H 'content-type: application/json' \
  -d '{"reason":"incident-1234"}' \
  http://localhost:7430/api/admin/freeze
```

Correctness is enforced at the store: `web/tests/totpStore.test.mjs` verifies the RFC 6238 reference vector, proves replay rejection, exercises the ±1 step tolerance, and confirms enrollment / disable round-trip.

## Previously: per-API-key usage analytics

Procurement reality: enterprise buyers will not approve a credential model they cannot meter. Every security review asks for per-key request volume, success rate, and route mix so abuse, runaway integrations, and seat-level billing disputes can be triaged from a single screen. SignalClaw now writes a counter on every authenticated `/api/v1/*` request, bucketed by `(key_id, UTC day, route_class, status_class)`, with a 35 day ring buffer. The counter is dropped at the single terminal `observeRequest` point inside `web/lib/v1Guard.ts`, so every existing v1 route is covered with no per-route edits. Owners can read the analytics via a new admin endpoint and a dedicated admin console page, including a dense daily series suitable for sparklines and a per-route breakdown.

Try it locally: `cd web && npm run dev`, then open http://localhost:7430/settings/keys/usage and pick a key. Or drive it from the API:

```bash
# Get usage for one key over the last 14 days (default).
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/keys/$KEY_ID/usage | jq .

# Narrow the window. `days` is clamped to [1, 35].
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:7430/api/admin/keys/$KEY_ID/usage?days=7" | jq .
```

Isolation is enforced at the store: `tests/keyUsageStore.test.mjs` proves one key's traffic never bleeds into another key's summary, the dense daily axis is the exact requested length, the unknown-key path returns an empty (but well-formed) payload with no secret-shaped fields, and the per-key bucket history is bounded by the 35 day ring buffer.

## Previously: per-source-IP failed authentication lockout

Procurement reality: every enterprise security questionnaire asks how the product defends against credential stuffing and brute-force token guessing. SignalClaw now tracks failed API key attempts per client IP and locks that source out of `authenticate()` for a configurable cooldown once a configurable threshold of failures is hit inside a configurable window. The chokepoint is the single `authenticate()` function in `web/lib/keyStore.ts`, so every existing route (42 v1 and admin endpoints, no sweep required at call sites) inherits the protection. Successful authentication from the same IP clears the counter, and missing credentials never count toward lockout so unauthenticated browser probes do not trip it. Locked IPs, the active config, and every config change are surfaced in the audit chain and in a dedicated admin settings page.

Try it locally: `cd web && pnpm dev`, then open http://localhost:7430/settings/auth-lockout. Drive it from the API with the admin key:

```bash
# Inspect the policy and current lockouts.
curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  http://localhost:7430/api/admin/auth-lockout | jq .

# Turn on enforcement: 5 failures in 5 minutes, 15 minute cooldown.
curl -s -X PUT -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"threshold":5,"window_seconds":300,"cooldown_seconds":900}' \
  http://localhost:7430/api/admin/auth-lockout | jq .

# Manually clear one IP after a false positive.
curl -s -X DELETE -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
  "http://localhost:7430/api/admin/auth-lockout?ip=203.0.113.10"
```

## Previously: emergency workspace freeze (break-glass kill switch)

Procurement reality: enterprise security teams want a single lever that halts every authenticated API call for a workspace during a suspected breach, leaked CI secret, billing dispute, or compliance review. Revoking keys one by one is too slow, and IP allowlists only help if you know the attacker's IP. SignalClaw now ships a workspace-wide freeze. When enabled, every `/api/v1/*` request returns `HTTP 503 workspace_frozen` with `x-workspace-frozen: 1` and `Retry-After: 0` headers before any handler, rate limiter, quota, or residency check runs. Admin routes deliberately stay reachable so an operator can unfreeze. Freeze and unfreeze events are written to the tamper-evident audit log with actor, reason, and timestamp.

Try it locally: `cd web && npm run dev`, then

```bash
# Freeze the workspace with an audit-logged reason.
curl -s -X POST http://localhost:7430/api/admin/freeze \
  -H 'Content-Type: application/json' \
  -d '{"reason":"suspected key leak in CI logs"}' | jq

# Every v1 call now returns 503 workspace_frozen.
curl -s -i http://localhost:7430/api/v1/whoami -H "Authorization: Bearer $SEC" | head -n 5
# HTTP/1.1 503 Service Unavailable
# x-workspace-frozen: 1
# retry-after: 0

# Unfreeze when the incident is resolved.
curl -s -X DELETE http://localhost:7430/api/admin/freeze | jq
```

UI: visit http://localhost:7430/settings/freeze for the freeze and unfreeze console with a typed FREEZE confirmation guard.

## New: per-API-key route allowlist (least privilege)

Enterprise procurement reviewers ask whether a single leaked API key can reach every endpoint. SignalClaw now narrows individual keys to a specific list of `/api/v1/*` paths on top of the existing scope (`read` / `trade` / `admin`) and IP allowlist checks. Empty allowlist means “any v1 path the scope already permits”; non-empty means everything else is rejected with `403 route_not_allowed` before any rate-limit token, quota, or handler body runs, and the denial is written to the tamper-evident audit chain.

Try it locally: `cd web && pnpm dev`, then

```bash
# Mint a read-only key, then narrow it to /api/v1/runs only.
KID=...   # id returned by POST /api/admin/keys
SEC=...   # the one-time plaintext secret

curl -s -X PUT http://localhost:7430/api/admin/keys/$KID/route-allowlist \
  -H 'Content-Type: application/json' \
  -d '{"route_allowlist":["/api/v1/runs","/api/v1/watchlist"]}' | jq

curl -s -o /dev/null -w 'runs   HTTP %{http_code}\n' -H "Authorization: Bearer $SEC" \
  http://localhost:7430/api/v1/runs          # 200
curl -s -o /dev/null -w 'alerts HTTP %{http_code}\n' -H "Authorization: Bearer $SEC" \
  http://localhost:7430/api/v1/alerts        # 403 route_not_allowed
```

UI: visit http://localhost:7430/settings/keys and use the **Route allowlist** button on any active key.

![landing](docs/screenshots/landing.png)

## What's new

- **Strict, env-driven CORS allowlist on every `/api/*` response.** The edge middleware already minted request IDs and set the SOC2 header baseline (HSTS, X-Frame-Options, COOP, CORP) on every response, but cross-origin browser access was implicit: no `Access-Control-Allow-Origin`, no preflight handler, so any first-party browser SDK either had to be proxied through the same origin or run in a permissive dev posture. A new `web/lib/corsPolicy.ts` is the single source of truth: it reads `SIGNALCLAW_CORS_ORIGINS` (comma-separated, byte-for-byte exact origins, scheme plus host plus optional port, no suffix or regex matching), refuses anything that does not parse as `http(s)://host[:port]`, and only ever echoes an allowlisted origin back. In production posture (`SIGNALCLAW_ADMIN_KEY` set) with no allowlist the policy denies every browser origin, including loopback, so misconfiguration fails closed. In local single-user mode (no admin key, no allowlist) it admits `http://localhost:*` and `http://127.0.0.1:*` so a fresh install works without extra env. The middleware short-circuits `OPTIONS` preflight with `204`, sets `Vary: Origin` on every `/api/*` response (so a shared cache cannot poison `Access-Control-Allow-Origin`), and emits `Access-Control-Allow-Credentials: true` plus `Access-Control-Expose-Headers` covering `X-Request-Id`, `X-RateLimit-*`, and `Retry-After` so SDKs can read the rate-limit envelope from JavaScript. A new admin-gated `GET /api/admin/cors` route returns the effective policy (production flag, parsed origins, loopback default, allow methods, allow headers, expose headers, max age) and is intentionally read-only because the allowlist is a deploy artifact, not a dashboard knob. `/settings/cors` renders the readout for owners. Covered by `tests/corsPolicy.test.mjs` (17 cases): allowlist parsing dedupes and drops malformed entries, production posture denies even loopback when no allowlist is set, exact-match wins, suffix attacks (`evil.app.example.com`, `app.example.com.attacker.io`) are rejected, `javascript:` and `file://` schemes are rejected, `applyCors` sets credentials and expose headers on simple responses but only sets methods, headers, and max age on preflight, denied responses still set `Vary: Origin`, and the middleware source is pinned to import the shared policy and short-circuit `OPTIONS` so a future refactor cannot silently regress to a wildcard.

  Try it locally: `cd web && npm run dev` then
  ```bash
  # Local mode (no admin key): loopback is permitted by default.
  curl -s -i -X OPTIONS http://localhost:7430/api/v1/whoami \
    -H 'Origin: http://localhost:3000' \
    -H 'Access-Control-Request-Method: GET' | head -n 12
  # HTTP/1.1 204 No Content
  # access-control-allow-origin: http://localhost:3000
  # access-control-allow-credentials: true
  # access-control-allow-methods: GET, POST, PUT, DELETE, OPTIONS
  # vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers

  # Production posture with an explicit allowlist.
  export SIGNALCLAW_ADMIN_KEY=sc_live_bootstrap_admin
  export SIGNALCLAW_CORS_ORIGINS=https://app.example.com

  # Allowlisted origin: ACAO is echoed.
  curl -s -i -X OPTIONS http://localhost:7430/api/v1/whoami \
    -H 'Origin: https://app.example.com' \
    -H 'Access-Control-Request-Method: GET' | head -n 6

  # Unlisted origin: no ACAO header, browser blocks the request.
  curl -s -i -X OPTIONS http://localhost:7430/api/v1/whoami \
    -H 'Origin: https://evil.example.com' \
    -H 'Access-Control-Request-Method: GET' | head -n 6

  # Admin-gated readout of the effective policy.
  curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    http://localhost:7430/api/admin/cors | jq
  ```
  Unsetting `SIGNALCLAW_CORS_ORIGINS` in production posture returns to deny-all for browser origins (server-to-server bearer-token traffic is unaffected).

- **Admin gating on the entire `/api/webhooks/*` management surface.** The webhook signing-secret rotation route already enforced an admin posture, but the sibling create/list/get/delete/replay/fire-test routes were wide open: anyone who reached the dashboard could create a subscription pointing at an arbitrary URL, list every configured endpoint and its events, delete subscriptions, replay a prior delivery, or fire a synthesized event from the latest run. That's a procurement red flag (SSRF + abuse + tenant exposure) the moment SignalClaw is reachable from anything other than `localhost`. A new shared gate (`web/lib/adminGuardCore.ts`, adapted into Next via `web/lib/adminGuard.ts`) factors the existing `/api/admin/network-policy` policy out of copy-paste range: in local single-user mode (no `SIGNALCLAW_ADMIN_KEY` env var) the call passes and writes a `local-mode` line to the tamper-evident audit chain, exactly as today; in production posture (`SIGNALCLAW_ADMIN_KEY` set) the request must present an authenticated key with the `admin` scope or it's refused with `403 forbidden` and a `forbidden:admin-required` audit line. The same gate is now wired into `GET/POST /api/webhooks`, `GET/DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/rotate-secret`, `GET /api/webhooks/deliveries`, `POST /api/webhooks/deliveries/:id/replay`, and `POST /api/webhooks/fire/latest`, and each handler audits success too (with `webhook_id`, target URL, delivery counts, or replay metadata in `details`) so a SOC2 reviewer can reconstruct every change to the webhook surface from the existing audit chain. Covered by `tests/webhookAdminGuard.test.mjs`: local mode admits unauthenticated callers, production posture rejects unauthenticated callers, unknown bearers, and real keys without admin scope (proving permission denial), admits the env admin secret, and a source-level check pins that every one of the six webhook management route files imports `requireAdmin` and short-circuits on `denied` so a future refactor can't silently reopen the surface.

  Try it locally: `cd web && npm run dev` then
  ```bash
  # Production posture: gate is on.
  export SIGNALCLAW_ADMIN_KEY=sc_live_bootstrap_admin

  # No bearer => 403, audit line written.
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:7430/api/webhooks
  # HTTP 403

  # Env admin bearer => 200 with the live subscription list.
  curl -s -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    http://localhost:7430/api/webhooks | jq

  # Same gate covers create, delete, replay, rotate-secret, and fire-latest.
  curl -s -X POST -H "Authorization: Bearer $SIGNALCLAW_ADMIN_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"url":"https://example.com/hook","events":["entered"],"tickers":["SPY"]}' \
    http://localhost:7430/api/webhooks | jq
  ```
  Unsetting `SIGNALCLAW_ADMIN_KEY` returns to local single-user mode without any code change.

- **Reversible API key suspension as the operational hold between revoke and rotate.** Revoke is permanent and rotate forces every legitimate client to redeploy a new secret; neither is the right tool when a SOC2 incident response (or an enterprise customer's billing dispute) needs the key to stop authenticating *right now* with the option to lift the hold in five minutes. `web/lib/keyStore.ts` now carries `suspended` / `suspended_at` / `suspended_reason` on every stored key, exposes a new `setKeySuspended(id, suspended, reason?)` primitive (rejects revoked keys and `env-admin`, caps the reason at 200 chars for the audit trail), and `authenticate()` refuses suspended keys before any route handler or rate-limit token is touched, so they fail uniformly with `401 unauthorized` across `/api/v1/*` and the admin surface. A new `GET/PUT /api/admin/keys/:id/suspend` route returns the live hold state and toggles it with `{ suspended: boolean, reason?: string|null }`, writes the existing tamper-evident audit chain under `reason: suspend:active->suspended` (and back), and refuses `409 revoked` / `409 env_admin` so an operator cannot accidentally suspend an already-dead key or the bootstrap admin. The `/settings/keys` admin UI surfaces a `suspended` badge with the reason inline, swaps the action button between **Suspend** (prompts for a reason) and **Unsuspend** (confirm-only) per row, and disables both controls while a sibling action is in flight. Covered by `tests/keySuspend.test.mjs`: new keys are not suspended, suspending blocks `authenticate()` on the exact same secret, unsuspending restores it without rotation (proves reversibility), revoked keys and `env-admin` are refused, and reason is truncated at 200 chars.

  Try it locally: `cd web && npm run dev` then
  ```bash
  # Mint a key (local mode)
  CREATE=$(curl -s -X POST http://localhost:7430/api/admin/keys \
    -H 'Content-Type: application/json' \
    -d '{"label":"laptop","scopes":["read"]}')
  KID=$(echo "$CREATE" | jq -r .id)
  SEC=$(echo "$CREATE" | jq -r .secret)

  # Baseline: authenticates.
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $SEC" \
    http://localhost:7430/api/v1/whoami        # HTTP 200

  # Suspend with an audit reason.
  curl -s -X PUT "http://localhost:7430/api/admin/keys/$KID/suspend" \
    -H 'Content-Type: application/json' \
    -d '{"suspended":true,"reason":"incident-2026-05-31"}' | jq

  # Same secret now blocked at authenticate().
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $SEC" \
    http://localhost:7430/api/v1/whoami        # HTTP 401

  # Lift the hold without rotating.
  curl -s -X PUT "http://localhost:7430/api/admin/keys/$KID/suspend" \
    -H 'Content-Type: application/json' -d '{"suspended":false}' | jq

  curl -s -o /dev/null -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $SEC" \
    http://localhost:7430/api/v1/whoami        # HTTP 200
  ```
  UI: visit http://localhost:7430/settings/keys and use the **Suspend** / **Unsuspend** button on any active key.

- **Workspace network policy on the Next dashboard + `/api/v1/*`.** The Python service already shipped a global IP allowlist; the Node web tier had a settings page (`/settings/network`) wired to an admin endpoint that did not exist. That gap is now closed. A new `web/lib/networkPolicyStore.ts` is the single source of truth for the workspace-wide CIDR allowlist (IPv4 + IPv6, bare IPs promoted to `/32` or `/128`, dedupe-on-write, capped at `MAX_CIDR_ENTRIES`, persisted atomically at `.data/network-policy.json`). The new `GET/PUT /api/admin/network-policy` route returns the live policy plus `max_cidrs` and writes the existing audit chain with the full before/after diff under reason `network_policy_updated`. Enforcement is wired into `web/lib/v1Guard.ts` ahead of the per-key IP allowlist, monthly quota, rotation, and per-minute rate limit, so every `/api/v1/*` call from an off-policy source IP is rejected with `403 { error: { code: "network_policy_block", message } }` and an audit line with `reason: network_policy_block:<not-matched|no-ip>` before any handler or rate-limit token is touched. Loopback (`127.0.0.1`, `::1`) is always allowed so on-box liveness probes keep working, and the store refuses to persist `enabled: true` with an empty CIDR list so an operator cannot lock themselves out from the dashboard in a single click. Covered by `tests/networkPolicy.test.mjs` (default disabled, disabled-policy pass-through, empty-allowlist lockout protection, invalid CIDR rejection, non-array type rejection, enforcement allows listed IPv4 + IPv6, blocks unlisted, treats loopback as always allowed, denies when source IP cannot be determined).

  Try it locally: `cd web && npm run dev` then
  ```bash
  curl -s http://localhost:7430/api/admin/network-policy | jq
  curl -s -X PUT http://localhost:7430/api/admin/network-policy \
    -H 'content-type: application/json' \
    -d '{"enabled": true, "cidrs": ["10.0.0.0/8", "203.0.113.5"]}' | jq
  ```
  Open `http://localhost:7430/settings/network` to manage CIDRs from the dashboard.

- **Per-workspace data residency policy.** Enterprise procurement and GDPR Article 44 both require that customers pin where their workspace is allowed to be written from. A new `web/lib/residencyStore.ts` is the single source of truth: operators choose a pinned region (`us`, `eu`, `ap`, or `global`) and a mode (`off`, `monitor`, `enforce`), persisted at `.data/residency-policy.json` with defaults from `SIGNALCLAW_DATA_REGION` / `SIGNALCLAW_RESIDENCY_MODE` so existing installs are unaffected. Enforcement is wired into `web/lib/v1Guard.ts` ahead of the quota and rate-limit steps so every `/api/v1/*` request now resolves a region from `x-data-region` (explicit) or `x-vercel-ip-country` / `cf-ipcountry` (edge), passes through with `X-Data-Region`, `X-Data-Region-Resolved`, and `X-Data-Region-Source` headers, and either records a `residency_warn` audit line on mismatch (monitor mode) or blocks the mutating request with `451 { error: { code: "residency_violation", policy_region, request_region, request_source } }` and a tamper-evident audit line (enforce mode). Reads are never blocked. Admins manage the policy from `/settings/security/residency`, which shows the live request region and warns before saving a configuration that would lock the operator out. Covered by `tests/residencyPolicy.test.mjs`: defaults, explicit region wins over edge country header, EEA country buckets resolve to `eu`, off mode always allows, enforce + match allows, enforce + mismatch on `POST` blocks (cross-region isolation), enforce + mismatch on `GET` passes with warn, monitor + mismatch passes with warn even on `POST`, persistence and invalid input rejection.

  Try it locally: `cd web && npm run dev` then
  ```bash
  export SC_ADMIN=sc_live_admin_key
  # Pin this workspace to EU and enforce on writes
  curl -s -X PUT -H "x-api-key: $SC_ADMIN" -H 'content-type: application/json' \
    -d '{"region":"eu","mode":"enforce"}' \
    http://localhost:7430/api/admin/residency | jq
  # A US-origin write is now blocked with HTTP 451
  curl -s -D - -X POST -H "x-api-key: $SC_ADMIN" -H 'x-data-region: us' \
    http://localhost:7430/api/v1/runs
  ```
  UI: visit http://localhost:7430/settings/security/residency.

- **Workspace API key rotation policy.** Enterprise procurement and SOC2 CC6.1 both require a documented maximum age for long-lived credentials. A new `web/lib/rotationPolicy.ts` is the single source of truth: operators set `max_age_days` (0 disables, default off for back-compat) and a `warn_days` window, persisted at `.data/rotation-policy.json` with defaults from `SIGNALCLAW_MAX_KEY_AGE_DAYS` / `SIGNALCLAW_KEY_ROTATION_WARN_DAYS`. Enforcement is wired into `web/lib/v1Guard.ts` so every `/api/v1/*` request now evaluates the calling key and either passes through with `X-Key-Age-Days`, `X-Key-Rotate-By`, `X-Key-Rotation-Days-Remaining`, and (inside the warn window) `X-Key-Rotation-Status: warning` headers, or is blocked with a structured `403 { error: { code: "key_rotation_required", age_days, max_age_days, rotate_by } }` and a tamper-evident audit line so reviewers can see exactly which stale key was denied. Admins manage the policy from `/settings/security/rotation`, which shows live counts of stale and rotate-soon keys plus a per-key age table and deep-links to the existing rotation UI. Covered by `tests/rotationPolicy.test.mjs`: default-disabled behaviour, ok / warning / stale state transitions across the boundary days, persistence and negative-value rejection, and an end-to-end keyStore round-trip proving a stale key is denied while a fresh key from the same store keeps working (per-key isolation, not a global kill switch).

  Try it locally: `cd web && npm run dev` then
  ```bash
  export SC_ADMIN=sc_live_admin_key
  # Enable: 90-day max age, warn during the last 14 days
  curl -s -X PUT -H "x-api-key: $SC_ADMIN" -H 'content-type: application/json' \
    -d '{"max_age_days":90,"warn_days":14}' \
    http://localhost:7430/api/admin/rotation-policy | jq
  # Read policy + per-key age snapshot
  curl -s -H "x-api-key: $SC_ADMIN" http://localhost:7430/api/admin/rotation-policy | jq
  # Every v1 response now carries rotation headers
  curl -s -D - -H "x-api-key: $SC_ADMIN" http://localhost:7430/api/v1/runs | grep -i '^x-key-'
  ```
  UI: visit http://localhost:7430/settings/security/rotation.

- **Per-API-key monthly request quota.** Enterprise contracts are written against a calendar-month allowance, not a per-minute burst. The per-minute rate limit was already in place, but a steady client could quietly burn through a contract's monthly cap without anyone noticing until the invoice. A new `web/lib/monthlyQuotaStore.ts` is the single source of truth for per-key monthly request budgets (0 = unlimited, configurable per key, defaultable via `SIGNALCLAW_MONTHLY_QUOTA`). It runs inside `web/lib/v1Guard.ts` ahead of the per-minute limiter, so every `/api/v1/*` endpoint now ships standard `X-Quota-Limit`, `X-Quota-Used`, `X-Quota-Remaining`, `X-Quota-Period`, and `X-Quota-Reset` headers on every response. Once a key passes its cap the guard returns `429 { error: { code: "monthly_quota_exceeded", limit, used, period, reset_at } }`, writes a structured audit line so SOC2 reviewers can see exactly who hit the ceiling and when, and keeps blocking until the first of the next UTC month rolls the counter. Operators manage the cap with `GET/PUT /api/admin/keys/:id/monthly-quota` and from the `/settings/keys` console, which surfaces current period usage, remaining requests, and reset time inline next to the rate limit editor. Covered by `tests/monthlyQuota.test.mjs`: unlimited-by-default behaviour, override caps that 429 once exhausted, calendar-month roll-over reset, per-key isolation across tenants, header canonicalisation for both limited and unlimited keys, validation rejection of negatives and absurd values, and a concurrent-reserve stress check that proves the file-backed counter does not lose writes under load.

  Try it locally: `cd web && npm run dev` then
  ```bash
  # Mint a key in the UI at http://localhost:7430/settings/keys, then:
  export SC_KEY=sc_live_xxxxxxxx
  # Cap this key at 1000 requests / month
  curl -s -X PUT -H "x-api-key: $SC_KEY" -H 'content-type: application/json' \
    -d '{"quota":1000}' http://localhost:7430/api/admin/keys/<KEY_ID>/monthly-quota | jq
  # Read current usage + cap
  curl -s -H "x-api-key: $SC_KEY" http://localhost:7430/api/admin/keys/<KEY_ID>/monthly-quota | jq
  # Every v1 response now carries quota headers
  curl -s -D - -H "x-api-key: $SC_KEY" http://localhost:7430/api/v1/runs | grep -i '^x-quota'
  ```
  UI: visit http://localhost:7430/settings/keys and click **Monthly quota** on any key.

- **Machine-readable OpenAPI 3.1 spec for the v1 surface.** Enterprise procurement and security review both ask the same first question: "hand me the API spec." A new `web/lib/openapiSpec.ts` is the single source of truth for every public `/api/v1/*` operation, served unauthenticated at `GET /api/v1/openapi.json` with public caching headers and CORS so Swagger UI, Postman, Stoplight, and `openapi-generator` can pull it without credentials. The spec declares both auth schemes (`Authorization: Bearer` and `x-api-key`), per-operation scopes (`read` / `trade` / `admin`), documents the `401`, `403`, and `429` error envelopes including the `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers, and references reusable component schemas for runs, watchlist, alerts, audit events, and the structured error envelope. `/docs` now surfaces a download button plus a raw-view link so an operator can hand it to a customer in one click. Covered by `tests/openapiSpec.test.mjs`: structural OpenAPI 3.1 conformance, every declared path resolves to a real `route.ts` on disk (drift guard), every operation declares 200/401/403/429 with the rate-limit headers, operationIds are unique, every `$ref` resolves to a declared component schema, and the `servers` block honours the caller origin.

  Try it locally: `cd web && npm run dev` then
  ```bash
  # Public, no auth required
  curl -s http://localhost:7430/api/v1/openapi.json | jq '.info, (.paths | keys)'
  # Generate a typed client
  npx @openapitools/openapi-generator-cli generate \
    -i http://localhost:7430/api/v1/openapi.json -g typescript-fetch -o ./sdk
  ```
  UI: visit http://localhost:7430/docs and click **openapi.json**.

- **Privacy and data control (GDPR Article 17 and 20).** Procurement and SOC2 reviewers both ask the same question: can an operator export everything you store about this workspace, and can the workspace owner irreversibly erase it? The previous account export at `/api/settings/export` was unauthenticated, wrote nothing to the audit log, and bundled only a partial subset of stores. A new `web/lib/privacyStore.ts` is the single source of truth for every `.data/*.json(l)` file we own, tagged `user` or `compliance`. `GET /api/admin/privacy/export` (admin scope, audit logged) streams a single JSON bundle containing every user store plus a copy of the audit log and API key metadata so a customer can verify what we retain about them. `POST /api/admin/privacy/delete` (admin scope, audit logged, requires `{"confirm":"DELETE"}`) erases user-generated state by default and preserves compliance stores (audit log, keys, idempotency, rate limits, delivery logs) so SOC2 evidence is not destroyed by accident; opt-in flags `wipe_compliance` and `wipe_audit` let an operator scorch them too. `GET /api/admin/privacy/delete?wipe_compliance=...&wipe_audit=...` returns a dry-run plan so the UI shows exactly which files will be removed and which will be preserved before anyone clicks the button. The legacy `/api/settings/export` and `/api/settings/delete` routes are re-routed through the same store and now require admin scope when one is configured, closing the unauth export hole. `/settings/privacy` ships a focused page: a one-click signed export, a dry-run impact preview that updates as the wipe checkboxes toggle, and a danger zone that only enables the Erase button after the user types `DELETE`. Covered by `tests/privacyStore.test.mjs`: every known store appears in the export, JSON and JSONL files round-trip, the default erase plan removes user data and preserves audit + keys, the wipe flags promote compliance and audit files into the remove list, on-disk files matching that plan are actually unlinked, and the operation is idempotent on missing files.

  Try it locally: `cd web && pnpm dev` then
  ```bash
  # Mint an admin key at http://localhost:3000/settings/keys, then:
  export SC_KEY=sc_live_xxxxxxxx
  # Download a full workspace export
  curl -OJ -H "x-api-key: $SC_KEY" http://localhost:3000/api/admin/privacy/export
  # Preview what an erase would remove (no data touched)
  curl -s -H "x-api-key: $SC_KEY" 'http://localhost:3000/api/admin/privacy/delete?wipe_compliance=false&wipe_audit=false'
  # Actually erase user data (compliance + audit preserved)
  curl -s -X POST -H "x-api-key: $SC_KEY" -H 'content-type: application/json' \
    -d '{"confirm":"DELETE"}' http://localhost:3000/api/admin/privacy/delete
  ```
  UI: visit http://localhost:3000/settings/privacy.

- **Multi-day audit search and CSV export.** SOC2 and ISO 27001 reviewers expect operators to answer "show me every mutating call from key X over the past 30 days where status was 4xx or 5xx, and hand me the CSV." The existing `/audit` endpoint only tailed a single day with no filters. Two new admin-scoped routes close that gap: `GET /audit/search` accepts `actor_label`, `actor_key_hash`, `method`, `status`, `status_min`, `path_prefix`, `path_contains`, `action`, `from_ts`, `to_ts`, `days_back` (clamped 1..365), `limit`, and `offset`; it walks daily JSONL files newest-first and returns a paginated JSON page. `GET /audit/export.csv` takes the same filters and streams a CSV download (header row + matching events) so a 30-day export of a busy install never has to materialise in memory. The web UI at `/settings/audit` gets an Export CSV button that always reflects the current filter view, mirrored at `/api/audit/export.csv` against the Next.js audit store. Covered by `tests/test_audit_search_export.py`: filtering by `status_min` + `actor_label`, method + path prefix, the CSV header + escaping, admin-scope enforcement on both routes, and the `days_back` clamp.

  Try it locally:
  ```bash
  uvicorn signalclaw.api:app --port 7431 &
  # Last 30 days, every failure (>=400) from key labelled "ops"
  curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    'http://127.0.0.1:7431/audit/search?status_min=400&actor_label=ops&days_back=30'
  # Same filter, downloaded as CSV
  curl -s -OJ -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    'http://127.0.0.1:7431/audit/export.csv?status_min=400&actor_label=ops&days_back=30'
  ```
  Or visit `http://127.0.0.1:3000/settings/audit` and click **Export CSV**.

- **Configurable request body size limit (DoS guard).** Enterprise security reviews routinely flag APIs that accept unbounded request bodies, since an attacker can ship a multi-gigabyte payload and pin the process before any auth check runs. A new ASGI-level middleware caps every mutating request in two layers: it rejects on the declared `Content-Length` header before reading a byte, and it streams-guards clients that omit the header (chunked or broken) by tallying bytes as they arrive. Both paths return `413` with a structured `{error, message, limit_bytes, declared_bytes}` JSON envelope and an `X-Body-Limit-Bytes` response header. Rejections are written to the audit log as `body.limit.exceeded` with the observed bytes, the active cap, and which layer fired. The cap is admin-managed at runtime via `GET/PUT /admin/body-limit` (admin scope plus MFA gate), persisted to `<data_dir>/body_limit.json`, clamped to 1 KiB - 1 GiB, and seedable on boot with `SIGNALCLAW_BODY_LIMIT_BYTES`. GET/HEAD/OPTIONS are exempt. Covered by `tests/test_body_limit.py`: default cap, lowering the cap rejects oversized payloads, GET is exempt, non-admin keys cannot mutate the cap, invalid inputs return 400, and rejections land in the audit log.

  Try it locally:
  ```bash
  uvicorn signalclaw.api:app --port 7431 &
  # Read current cap
  curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" http://127.0.0.1:7431/admin/body-limit
  # Lower the cap to 2 KiB
  curl -s -X PUT http://127.0.0.1:7431/admin/body-limit \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"max_bytes": 2048}'
  # Send a 4 KiB body and watch it reject with 413
  curl -s -o /dev/stderr -w '%{http_code}\n' -X POST http://127.0.0.1:7431/watchlist \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    --data "$(printf '{\"ticker\":\"AAA\",\"blob\":\"%4000s\"}' x)"
  ```

- **Strict workspace CORS allowlist, replacing `allow_origins=["*"]`.** Procurement reviews flag any FastAPI service that ships a wildcard CORS default; combined with an exposed dashboard it lets any web page in the world drive the API from a victim browser. The signalclaw API now defaults to CORS **off** (no `Access-Control-Allow-*` headers, same-origin only) and exposes an audited admin surface for adding explicit origins. Origins are strictly validated (`https://host[:port]`, with `http://` only for loopback), wildcards and `null` are refused, and turning the policy on with an empty allowlist is rejected so an operator cannot accidentally regress to a permissive default. The store is JSON-backed under `<data_dir>/cors_policy.json`, threadsafe, and seeded from `SIGNALCLAW_CORS_ORIGINS` on first boot. Preflights from unlisted origins return 403 with no ACAO header, and the middleware reflects only request headers from a tight safe-list. Covered by `tests/test_cors_policy.py`: wildcard rejection, zero-headers on fresh deploys, evil-origin denial, allowed-origin round trip with `Vary: Origin`, and header filtering.

  Try it locally:
  ```bash
  uvicorn signalclaw.api:app --port 7431 &
  # Inspect the current policy (defaults to disabled)
  curl -s -H "x-api-key: $SIGNALCLAW_API_KEY" \
       http://127.0.0.1:7431/admin/cors-policy | jq
  # Enable for a specific dashboard origin
  curl -s -X PUT -H "x-api-key: $SIGNALCLAW_API_KEY" \
       -H "content-type: application/json" \
       -d '{"enabled":true,"origins":["https://app.example.com"]}' \
       http://127.0.0.1:7431/admin/cors-policy | jq
  # Preflight from an unlisted origin is rejected (403, no ACAO)
  curl -i -X OPTIONS http://127.0.0.1:7431/watchlist \
       -H "Origin: https://evil.example.com" \
       -H "Access-Control-Request-Method: GET"
  ```

- **Forensic last-use fingerprint on every API key.** Procurement and SOC2 incident response need to answer "who used this credential, from where, with what client?" without trawling raw logs. Every successful authentication now lazily stamps `last_used_ip` and `last_used_user_agent` (UA truncated to 256 chars) onto the stored key alongside the existing `last_used_at`, persisted in the JSON store and surfaced on `GET /admin/keys` and the `/settings/keys` page. Threading is wired through both `require_api_key` (per-route dependency) and the scope-enforcing middleware, so admin, member, and viewer keys are all covered. Bookkeeping is best-effort and never blocks auth. Covered by `tests/test_api_keys_last_used_fingerprint.py`: a fresh key has no fingerprint, a single authed call populates IP + UA + timestamp, and a 4 KiB User-Agent is capped at 256 bytes so a hostile caller cannot bloat the store.

  Try it locally:
  ```bash
  uvicorn signalclaw.api:app --port 7431 &
  # Mint a key (admin scope required)
  curl -s -X POST http://127.0.0.1:7431/admin/keys \
    -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" \
    -H 'content-type: application/json' \
    -d '{"label":"forensic-probe","scopes":["read"]}'
  # Use the returned secret; the next /admin/keys listing shows where it was last used.
  curl -s -H "x-api-key: $NEW_SECRET" -A 'my-bot/1.0' http://127.0.0.1:7431/watchlist
  curl -s -H "x-api-key: $SIGNALCLAW_ADMIN_KEY" http://127.0.0.1:7431/admin/keys \
    | jq '.keys[] | {label, last_used_at, last_used_ip, last_used_user_agent}'
  ```
  Or open `http://localhost:3000/settings/keys` and read the new `from <ip> · <user-agent>` line under each key.

- **HTTP security headers stamped on every API and dashboard response.** Procurement and pentest checklists (SOC2, ISO 27001, OWASP ASVS L2) all ask for the same short list: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a locked-down `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, and a strict `Content-Security-Policy` (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'` for the JSON API). A new `SecurityHeadersMiddleware` sits at the outer edge of the FastAPI middleware chain so the headers also flow back through auth 401s, scope 403s, rate-limit 429s, and readiness 503s, not just happy-path 200s. The Next edge middleware mirrors the same baseline so a browser hitting either surface gets identical guarantees. Knobs (env): `SIGNALCLAW_SECURITY_HEADERS_ENABLED` (set `0` for plain-HTTP staging), `SIGNALCLAW_HSTS_MAX_AGE` (default `31536000`, `0` suppresses HSTS), `SIGNALCLAW_HSTS_INCLUDE_SUBDOMAINS` (default `1`), `SIGNALCLAW_HSTS_PRELOAD` (default `0`), and `SIGNALCLAW_CSP` to override the API CSP. A public `/.well-known/security.txt` (RFC 9116) ships disclosure contact, policy URL, and expiry (overridable via `SIGNALCLAW_SECURITY_CONTACT`, `SIGNALCLAW_SECURITY_POLICY_URL`, `SIGNALCLAW_SECURITY_TXT_EXPIRES`). A new admin endpoint `GET /admin/security-headers` (admin scope + MFA) returns the effective policy byte-identical to what the middleware stamps, so a procurement reviewer can point a scanner at one URL and confirm the configuration. The `/settings/security` page renders the live policy in a per-header table with `on`/`missing` badges and the resolved values. Covered by `tests/test_security_headers.py`: baseline headers present on `/healthz`, `/metrics`, 404s, and anonymous 401/403s; HSTS preload + subdomains overrides take effect; HSTS suppressed when `MAX_AGE=0`; CSP override applied; the `setdefault` contract preserves a handler-set CSP; `/.well-known/security.txt` returns `Contact:`, `Expires:`, `Policy:`; `/admin/security-headers` reflects the same dict.

  Try it locally:
  ```bash
  uvicorn signalclaw.api:app --port 7431 &
  # Baseline headers on a public probe:
  curl -si http://127.0.0.1:7431/healthz | grep -iE 'strict-transport|content-security|x-frame|referrer|permissions|cross-origin'
  # Disclosure file:
  curl -s http://127.0.0.1:7431/.well-known/security.txt
  # Admin reflector (requires an admin-scoped key with MFA):
  curl -s -H "x-api-key: $SC_ADMIN_KEY" -H "x-mfa-code: $(oathtool --totp -b $SC_TOTP)" \
    http://127.0.0.1:7431/admin/security-headers | jq .
  ```

- **Idempotency-Key support for every mutating `/api/v1/*` endpoint**. Stripe-style retries are table-stakes for any API a customer is going to wire into their order pipeline: a flaky network must not double-arm an alert or double-save a run. Every POST, PATCH, and DELETE under `/api/v1/*` (alerts, alert check, runs, watchlist, watchlist/[ticker]) now accepts an optional `Idempotency-Key` header. The first call with a given (api-key id, header) executes the work and caches the response for 24 hours; subsequent calls with the same body return the cached status + body and add `Idempotent-Replayed: true` so the handler does not run twice. Reusing the same header value with a different body returns `409 idempotency_conflict` (handler not invoked) so a caller that accidentally mutates the body on retry sees a loud error instead of silent divergence. Records are scoped strictly by API-key id, so a second key reusing the same header value is a miss and not a conflict. Persistence is the same file-backed atomic-write pattern as the other stores under `web/.data/idempotency.json`, capped at 2000 records with a 24h sliding TTL and opportunistic GC on every read. Only 2xx responses are cached (so clients can fix a 4xx and retry), and the cached entry stores only a small whitelist of safe response headers (`location`, `etag`, `x-resource-id`) so replays do not echo stale rate-limit counters. Header validation rejects empty, oversized (>255), and non-printable values at the boundary with `400 bad_idempotency_key`. Replays and conflicts are both written to the audit chain with the originating Idempotency-Key so a reviewer can prove which retried requests were short-circuited and why. A new admin endpoint `GET /api/admin/keys/:id/idempotency` returns the recent cache entries (header, fingerprint prefix, status, bytes, created/expires) for one key without ever exposing the cached body, and `/settings/idempotency` surfaces a per-key picker with the live table so the key owner can see exactly which retries are landing. Covered by `tests/idempotency.test.mjs`: missing header is a pass-through, malformed header returns 400 without running the handler, the same key + same body returns the cached body and proves the handler did not run again, the same key + different body returns 409 without running the handler, 4xx responses are not cached so the next attempt runs again, and two different API keys reusing the same header value are isolated (different fingerprints, both stored, neither overwriting the other).

  Try it locally: `cd web && pnpm dev` then
  ```bash
  # Mint a key in the dashboard at http://localhost:7430/settings/keys, then:
  K=sc_live_your_minted_key_here
  IDK=$(uuidgen)

  # First call: real work, response cached for 24h
  curl -si -X POST http://localhost:7430/api/v1/watchlist \
    -H "authorization: Bearer $K" \
    -H "content-type: application/json" \
    -H "Idempotency-Key: $IDK" \
    -d '{"ticker":"AAPL","note":"flagship"}'

  # Replay: same body, returns the cached response with Idempotent-Replayed: true
  curl -si -X POST http://localhost:7430/api/v1/watchlist \
    -H "authorization: Bearer $K" \
    -H "content-type: application/json" \
    -H "Idempotency-Key: $IDK" \
    -d '{"ticker":"AAPL","note":"flagship"}' | grep -i idempotent-replayed

  # Conflict: same key, different body, returns 409 without mutating state
  curl -si -X POST http://localhost:7430/api/v1/watchlist \
    -H "authorization: Bearer $K" \
    -H "content-type: application/json" \
    -H "Idempotency-Key: $IDK" \
    -d '{"ticker":"MSFT"}'
  ```
  UI: visit http://localhost:7430/settings/idempotency and pick a key to see its cache.

- **Tamper-evident audit log with hash-chain verification**. SOC2 CC7.2 + CC7.3 require audit logs to be protected from undetected modification, and procurement reviewers fail any product that ships an `audit.jsonl` they can edit with `vi`. Every `recordAuditEvent` now computes an HMAC-SHA256 over the canonical event payload plus the previous event's hash, persists both `prev_hash` and `hash` on the row, and seeds the chain with a 32-byte random key written to `.data/audit.chainkey` (mode 0600, generated on first write, never rotated because rotating would invalidate prior links). The chain serializes through the existing write queue so concurrent route handlers cannot fork the log. `GET /api/audit/verify` (admin scope when `SIGNALCLAW_ADMIN_KEY` is set, open in local mode, mirroring `/api/audit`) walks the entire on-disk log (rolled + primary, oldest first), re-derives each link, and returns `{ok, checked, skipped_legacy, last_hash, break_at_index, break_event_id, reason}`; events written before this feature shipped are accepted as a pre-chain prefix so existing installs do not flip red. The verify call is itself recorded into the chain, so an auditor can prove not just integrity-right-now but that integrity-was-checked at a given timestamp. The `/settings/audit` page adds a Chain Integrity panel with a Verify button, an intact/broken badge, the last hash, and a precise break-at-index callout if the chain has been mutated. Covered by `tests/auditChain.test.mjs`: sequential writes link together, editing a single field on a recorded row trips `hash_mismatch` at the right index, dropping a middle event trips `prev_hash_mismatch`, and legacy unchained rows are tolerated as a pre-chain prefix.

  Try it locally: `cd web && pnpm dev` then
  ```bash
  # Walk the chain and report integrity
  curl -s http://localhost:7430/api/audit/verify | jq .

  # Now tamper with a row and re-verify (ok flips to false)
  sed -i '' '2s/"status":200/"status":500/' web/.data/audit.jsonl
  curl -s http://localhost:7430/api/audit/verify | jq '{ok, reason, break_at_index}'
  ```
  UI: visit http://localhost:7430/settings/audit and click Verify chain.

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

  The Next.js dashboard runs its own outbound delivery pipeline (`web/lib/webhookStore.ts`) on top of the same contract. `POST /api/webhooks/{id}/rotate-secret` mints or accepts a new HMAC secret, keeps the prior one as `previous_secret` until `previous_secret_expires_at`, and during the grace window every outbound delivery's `X-SignalClaw-Signature` header carries two repeated `v1=` MAC entries: one signed with the new secret, one with the previous, so receivers can verify with whichever they have wired up. `grace_seconds: 0` does an immediate cutover with no previous-secret retention; values above `604800` (7 days) are rejected as `invalid_grace`. Every rotation is appended to the hash-chained audit log (`route=/api/webhooks/{id}/rotate-secret`, `details.grace_seconds`, `details.had_previous`, `details.rotated_at`) and surfaces in the activity feed as `webhook.secret_rotated`. Covered by `web/tests/webhookRotateSecret.test.mjs` (rotate response shape, dual-signing inside the grace window, single-signing on `graceSeconds=0`, replace-while-still-rotating semantics, invalid-grace rejection, and 404 on unknown id).

  Try the Next-side rotation locally:
  ```bash
  cd web && pnpm dev
  # In another shell, after creating a webhook via the UI or POST /webhooks:
  curl -s -X POST http://localhost:7430/webhooks/$SUB/rotate-secret \
      -H "content-type: application/json" \
      -d '{"secret":"","grace_seconds":3600}' | jq .
  # => { id, secret, secret_rotated_at, previous_secret_expires_at, grace_seconds }
  ```

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
