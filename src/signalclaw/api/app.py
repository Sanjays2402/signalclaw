from __future__ import annotations
import os
import time
from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Any, Dict, Optional
from fastapi import FastAPI, Depends, HTTPException, Header, Request, Body
from pydantic import BaseModel, Field as PydField
from fastapi.middleware.cors import CORSMiddleware  # noqa: F401  (kept for compat)
from ..cors_policy import get_store as get_cors_store, normalise_origin, MAX_ORIGINS
from ..cors_policy.middleware import StrictCorsMiddleware

from ..config import get_settings
from ..logging_ import configure_logging, get_logger
from ..utils import init_tracing, instrument_fastapi, instrument_httpx
from ..observability import init_sentry, is_enabled as sentry_enabled
from ..data import WatchlistStore, load_ohlcv, fetch_ohlcv, save_ohlcv
from ..engine import run_daily, render_markdown
from ..features import build_features
from ..features.build import FEATURE_COLUMNS
from ..models import WatchHoldSkipClassifier, ReturnRegressor, Ensemble, make_labels
from ..explain import rationale_for, risk_flags as compute_risk_flags
from ..backtest import WalkForwardBacktest, walk_forward_optimize
from .schemas import (DailyReportOut, Pick, WatchlistOut, WatchlistIn, BacktestOut, BacktestTrade,
                       AlertIn, AlertOut, AlertListOut, AlertHitOut, AlertCheckOut,
                       AlertEventOut, AlertHistoryOut,
                       TradeIn, TradeOut, TradeListOut, PortfolioSnapshotOut,
                       SizingOut, SizingRequest,
                       CorrelationMatrixOut, DiversificationOut,
                       ReportSummaryOut, ReportHistoryOut, ReportDiffOut,
                       StopRuleIn, StopRuleOut, StopRuleListOut,
                       StopEventOut, StopCheckOut,
                       AttributionOut, EarningsIn, EarningsOut, EarningsListOut,
                       ConcentrationOut, TaxReportOut,
                       OptResultOut,
                       WebhookIn, WebhookOut, WebhookListOut,
                       WebhookRotateSecretIn, WebhookRotateSecretOut,
                       WebhookUpdateIn,
                       PickEventOut, WebhookDeliveryOut,
                       WebhookDeliveryLogItemOut, WebhookDeliveryLogOut,
                       DrawdownReportOut, JournalEntryIn, JournalEntryOut, JournalListOut,
                       ConvictionBucketOut, ConvictionStatsOut,
                       FxRateIn, FxRateOut, FxListOut,
                       TradeCurrencyIn, TradeCurrencyOut,
                       ConversionAuditOut, ConvertedTradesOut,
                       DeadLetterOut, DeadLetterListOut, DlqReplayOut,
                       NotifyTestIn,
                       BracketPlanIn, BracketFillIn, BracketCloseIn,
                       BracketPlanOut, BracketListOut, BracketStatsOut,
                       RotationOut,
                       NewsEventIn, NewsEventOut, NewsEventListOut, EventStudyOut,
                       CostModelIn, PretradeIn, PretradeOut,
                       ExecSimulateIn, ExecReportOut, LedgerEntryIn, LedgerEntryOut, LedgerListOut,
                       MarginConfigIn, MarginConfigOut, AccountSnapshotOut,
                       AnomalyOut, AnomalyReportOut,
                       ScalingPlanIn, ScalingPlanOut, ScalingPlanListOut,
                       ScaleRungIn, ScaleEvaluateIn,
                       ScaleEventOut, ScaleEvaluateOut,
                       ExplainOut, FeatureContribOut)
from .security import require_api_key
from .middleware import AccessLogMiddleware
from .dry_run import DryRunMiddleware
from .request_context import RequestContextMiddleware
from .rate_limit import RateLimitMiddleware, require_scope, ScopeEnforcementMiddleware, PerIPRateLimitMiddleware, IPAllowlistMiddleware, GlobalIPAllowlistMiddleware, PathAllowlistMiddleware, KeyExpiryWarningMiddleware
from .security_headers import SecurityHeadersMiddleware, build_header_policy
from .body_limit import (
    BodyLimitMiddleware,
    BodyLimitStore,
    MIN_LIMIT_BYTES,
    MAX_LIMIT_BYTES,
    DEFAULT_LIMIT_BYTES,
)
from ..network_policy import get_store as get_network_policy_store, normalise_cidr, MAX_CIDRS
from .metrics import install_metrics, data_dir_ready
from ..audit import AuditMiddleware, get_audit_log
from ..quotas import get_quota_store
from ..quotas.middleware import QuotaMiddleware
from ..audit.retention import AuditRetentionPruner, retention_config_from_env
from ..legal_hold import get_legal_hold_store
from ..subprocessors import (
    get_store as get_subprocessor_store,
    reset_store as _reset_subprocessor_store,  # noqa: F401  (test hook re-export)
    MAX_NAME as _SP_MAX_NAME,
    MAX_PURPOSE as _SP_MAX_PURPOSE,
    MAX_URL as _SP_MAX_URL,
)


class SubprocessorIn(BaseModel):
    """Body for POST /admin/subprocessors and PUT updates.

    Defined at module scope so pydantic resolves the ForwardRef when
    FastAPI builds the TypeAdapter.
    """
    name: Optional[str] = PydField(default=None, max_length=_SP_MAX_NAME)
    purpose: Optional[str] = PydField(default=None, max_length=_SP_MAX_PURPOSE)
    country: Optional[str] = PydField(default=None, min_length=2, max_length=2)
    url: Optional[str] = PydField(default=None, max_length=_SP_MAX_URL)
    data_categories: Optional[list[str]] = PydField(default=None)


class LegalHoldIn(BaseModel):
    """Request body for POST /admin/legal-hold.

    Defined at module scope (not inside create_app) so pydantic can
    fully resolve the ForwardRef when FastAPI builds its TypeAdapter.
    """
    key_hash: str = PydField(..., min_length=4, max_length=128,
                             description="audit actor hash to place under hold")
    reason: str = PydField(..., min_length=1, max_length=512)
    case_id: str = PydField(default="", max_length=128)

from ..privacy import StoreBundle, collect_user_data, erase_user_data
from ..privacy.export_formats import build_zip as _build_export_zip, export_filename as _export_filename
from ..alerts import (Alert, AlertCondition, AlertStore, AlertEventStore,
                       evaluate_alerts)
from ..api_keys import ApiKeyStore
from ..sso import (
    OidcConfig,
    OidcConfigStore,
    OidcClient,
    OidcError,
    StateStore as OidcStateStore,
    email_allowed as _oidc_email_allowed,
    extract_email as _oidc_extract_email,
)
from ..mfa import MfaStore, provisioning_uri
from .rate_limit import set_user_key_store, get_registry
from ..sessions import SessionStore
from ..sessions.middleware import SessionTrackingMiddleware
from ..sessions.revocation import RevocationStore
from ..portfolio import (PortfolioStore, Trade, TradeSide, compute_snapshot,
                          StopRule, StopKind, StopStore, evaluate_rules,
                          attribution, sector_exposure, tax_summary, LotMethod,
                          DrawdownConfig, DrawdownGuardStore, evaluate_guard,
                          filter_picks as drawdown_filter_picks,
                          JournalEntry, JournalStore, conviction_stats,
                          FxStore, TradeCurrencyMap, convert_trades, USD,
                          BracketPlan, BracketStore, compute_bracket_stats,
                          LedgerStore, LedgerEntry, EntryKind, MarginConfig,
                          ledger_snapshot,
                          ScalingPlan, ScaleRung, ScaleAction, PriceBar, ScalingPlanStore, evaluate_plan)
from ..notifier import (TelegramNotifier, DiscordNotifier, SlackNotifier,
                         DeadLetterQueue, RetryPolicy, send_with_retry,
                         replay_dlq, Notifier)
from ..risk import RiskConfig, size_pick
from ..risk.pretrade import CostModel, OrderRequest, simulate_order
from ..execution import (IntradayBar, ParentOrder, ScheduleKind,
                          simulate_execution as exec_simulate)
from ..correlation import correlation_matrix, diversification_warnings
from ..rotation import sector_rotation
from ..news_events import NewsEvent, NewsEventStore, event_study
from ..history import ReportArchive
from ..webhooks import (WebhookStore, WebhookSubscription, diff_picks,
                         deliver_events, replay_delivery,
                         DeliveryLogStore, EVENT_KINDS)
from ..regime import detect_regime, regime_series
from ..earnings import EarningsStore, EarningsDate
from ..quality import detect_anomalies, DetectorConfig


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    # Sentry must initialise before any middleware so its FastAPI
    # integration can wrap the ASGI stack. No-op when SENTRY_DSN is unset.
    init_sentry()
    init_tracing("signalclaw-api", settings.otel_endpoint)
    # httpx is shared across yfinance + notifier outbound calls; instrument
    # the client globally so spans for upstream fetches show up under the
    # request that triggered them.
    instrument_httpx()
    log = get_logger("api")
    if sentry_enabled():
        log.info("sentry.enabled")
    app = FastAPI(title="SignalClaw API", version="0.1.0",
                  description="NOT FINANCIAL ADVICE.")
    # OTel ASGI instrumentation must wrap the app before other middleware
    # add_middleware calls so spans cover the whole request, including
    # auth + audit. Excluded URLs (health/ready/metrics) are configured
    # inside instrument_fastapi to keep span volume bounded.
    instrument_fastapi(app)
    # Strict, dynamic CORS. Defaults to disabled (same-origin only) so a
    # fresh deploy never exposes the API to arbitrary web origins; admins
    # opt in by adding origins via PUT /admin/cors-policy or by setting
    # SIGNALCLAW_CORS_ORIGINS. No wildcards are ever emitted.
    # (SecurityHeadersMiddleware is added last, see below, so it sits at
    # the outer edge and stamps headers on responses produced by any
    # short-circuiting middleware further in the chain, e.g. an auth
    # 401 or a rate-limit 429.)
    cors_policy_store = get_cors_store(settings.data_dir)
    app.state.cors_policy_store = cors_policy_store
    app.add_middleware(StrictCorsMiddleware, store=cors_policy_store)
    app.add_middleware(AccessLogMiddleware)
    # Request context: binds request_id (and optional correlation_id)
    # into structlog contextvars so every downstream log line carries
    # the id without each handler having to thread it manually. Added
    # LAST so it wraps everything else and runs FIRST on the inbound
    # path (Starlette executes middleware in reverse add order).
    app.add_middleware(RequestContextMiddleware)
    # Prometheus instrumentation. Mounts /metrics and wraps every
    # request with a counter + latency histogram keyed by route
    # template (bounded cardinality). Installed before audit so the
    # /metrics path is excluded from audit via the exempt list below.
    install_metrics(app, version="0.1.0")
    # Audit log: persist who/what/when for mutating + auth-failed requests.
    # Sits inside CORS so it sees the real request status, including 401/403.
    audit_log = get_audit_log(settings.data_dir / "audit")
    # Legal hold registry. While any hold is active the audit pruner
    # skips its sweep and /privacy/delete refuses with 409. Required
    # for eDiscovery and regulator-ordered evidence preservation.
    legal_hold_store = get_legal_hold_store(settings.data_dir / "legal_hold")
    app.state.legal_hold_store = legal_hold_store
    # Subprocessor registry powers the public Trust Center page and
    # the admin CRUD under /admin/subprocessors. Versioned and audit
    # logged so customers can verify the 30-day DPA notice window.
    subprocessor_store = get_subprocessor_store(settings.data_dir / "subprocessors.json")
    app.state.subprocessor_store = subprocessor_store
    # Break-glass emergency admin elevation: time-boxed grants that
    # union ``admin`` into a non-admin key's scopes for the duration
    # of an incident. Issuance, revocation, and every use are audited.
    from ..break_glass import get_store as _get_bg_store, reset_store as _reset_bg_store  # noqa: F401
    break_glass_store = _get_bg_store(settings.data_dir / "break_glass.json")
    app.state.break_glass_store = break_glass_store
    # Background retention pruner: enforces a maximum age on JSONL
    # files under <data_dir>/audit/ so the log volume cannot grow
    # without bound. Reads SIGNALCLAW_AUDIT_RETENTION_DAYS (default 90)
    # and SIGNALCLAW_AUDIT_RETENTION_INTERVAL_SECONDS (default 3600).
    # Disabled when retention days is 0.
    _ret_days, _ret_interval = retention_config_from_env()
    audit_pruner = AuditRetentionPruner(
        audit_log,
        retention_days=_ret_days,
        interval_seconds=_ret_interval,
        hold_predicate=legal_hold_store.any_active,
    )
    audit_pruner.start()
    app.state.audit_pruner = audit_pruner
    # Sandbox / dry-run guard. Added BEFORE the audit middleware in
    # source order so it sits INSIDE audit on the inbound chain: audit
    # wraps it and still records dry-run probes with actor + path +
    # status. Scopes, MFA, rate limits, and IP allowlists are added
    # AFTER (outer) so they still gate sandbox probes; a caller cannot
    # use ?dry_run=true to bypass a permission check.
    app.add_middleware(DryRunMiddleware)
    app.add_middleware(
        AuditMiddleware,
        audit_log=audit_log,
        audit_reads=os.environ.get("SIGNALCLAW_AUDIT_READS", "0") == "1",
    )
    # Sandbox / dry-run guard. Sits INSIDE audit on the inbound
    # chain because it is added BEFORE audit in source order: audit
    # wraps it and still records dry-run probes with actor + path +
    # status. Scopes, MFA, rate limits, and IP allowlists are added
    # AFTER this and therefore run BEFORE it on the inbound chain, so
    # a sandbox probe still has to clear every permission check.
    if os.environ.get("SIGNALCLAW_RATE_LIMIT_ENABLED", "0") == "1":
        app.add_middleware(
            RateLimitMiddleware,
            default_per_minute=int(os.environ.get("SIGNALCLAW_RATE_LIMIT_READ_PER_MIN", "120")),
            write_per_minute=int(os.environ.get("SIGNALCLAW_RATE_LIMIT_WRITE_PER_MIN", "30")),
        )
    # Per-key monthly quota + standard X-RateLimit-* response headers.
    # Always on. Anonymous traffic is skipped so an unauthenticated
    # probe of /healthz never burns quota. Sits INSIDE the per-minute
    # limiter (added later therefore runs earlier on inbound) so a
    # bursty caller is shaped before they count against monthly cap.
    quota_store = get_quota_store(settings.data_dir / "quotas.json")
    app.state.quota_store = quota_store
    app.add_middleware(QuotaMiddleware, store=quota_store)
    # RBAC scope enforcement: applied globally so mutating endpoints
    # require a key with the ``trade`` scope and ``/admin/*`` requires
    # ``admin``, regardless of whether each route declared a per-route
    # dependency. Enabled by default; opt out with
    # SIGNALCLAW_RBAC_ENFORCE=0 for legacy single-key deployments that
    # want the old permissive behaviour.
    if os.environ.get("SIGNALCLAW_RBAC_ENFORCE", "1") == "1":
        app.add_middleware(ScopeEnforcementMiddleware)
    # Per-key IP allowlist. Enforced for user-managed keys that opt in
    # by setting an allowlist on their key; legacy env keys and
    # unauthenticated traffic are not affected. Shares the same XFF
    # trust knobs as the per-IP limiter so the resolved client IP is
    # consistent across middlewares.
    _ipa_trust_xff = os.environ.get("SIGNALCLAW_TRUST_FORWARDED", "0") == "1"
    _ipa_trusted_raw = os.environ.get("SIGNALCLAW_TRUSTED_PROXIES", "").strip()
    _ipa_trusted = tuple(p.strip() for p in _ipa_trusted_raw.split(",") if p.strip())
    app.add_middleware(
        IPAllowlistMiddleware,
        trust_forwarded=_ipa_trust_xff,
        trusted_proxies=_ipa_trusted,
    )
    # Per-key path-prefix allowlist. Least-privilege at the endpoint
    # level: a key minted with ``path_allowlist=["/v1/runs"]`` is
    # rejected with 403 if it tries to hit any other path, even if
    # its scopes would otherwise allow it. Empty allowlist = legacy
    # unrestricted behaviour. Added next to the IP allowlist so the
    # two per-key policies are evaluated together.
    app.add_middleware(PathAllowlistMiddleware)
    # Advisory expiry headers for user-managed keys. Runs after path
    # allowlist so a rejected request still tells the caller when their
    # credential is about to lapse. Window matches /admin/keys/expiring
    # default so a client polling either surface sees the same horizon.
    app.add_middleware(KeyExpiryWarningMiddleware, within_days=30)
    # Workspace-level global IP allowlist. Added near the outer edge
    # so it runs before auth/audit/rbac on the inbound chain and drops
    # off-network traffic before any handler or store work occurs.
    network_policy_store = get_network_policy_store(
        settings.data_dir / "network_policy.json")
    app.state.network_policy_store = network_policy_store
    app.add_middleware(
        GlobalIPAllowlistMiddleware,
        store=network_policy_store,
        trust_forwarded=_ipa_trust_xff,
        trusted_proxies=_ipa_trusted,
    )
    # Per-IP DoS guard. Added last so it executes first in the
    # middleware chain, shedding floods before auth, audit, or
    # per-key buckets see them. Enabled by default with a generous
    # cap; tune via SIGNALCLAW_PER_IP_PER_MIN. Set to 0 to disable.
    _per_ip = int(os.environ.get("SIGNALCLAW_PER_IP_PER_MIN", "600"))
    if _per_ip > 0:
        _trust_xff = os.environ.get("SIGNALCLAW_TRUST_FORWARDED", "0") == "1"
        _trusted_raw = os.environ.get("SIGNALCLAW_TRUSTED_PROXIES", "").strip()
        _trusted = tuple(p.strip() for p in _trusted_raw.split(",") if p.strip())
        app.add_middleware(
            PerIPRateLimitMiddleware,
            per_minute=_per_ip,
            trust_forwarded=_trust_xff,
            trusted_proxies=_trusted,
        )
    wl_path = settings.data_dir / "watchlist.json"
    store = WatchlistStore(wl_path)
    alert_store = AlertStore(settings.data_dir / "alerts.json")
    alert_event_store = AlertEventStore(settings.data_dir / "alert_events.json")
    portfolio_store = PortfolioStore(settings.data_dir / "portfolio.json")
    stops_store = StopStore(settings.data_dir / "stops.json")
    earnings_store = EarningsStore(settings.data_dir / "earnings.json")
    archive = ReportArchive(settings.data_dir / "reports")
    webhooks_store = WebhookStore(settings.data_dir / "webhooks.json")
    webhook_log_store = DeliveryLogStore(
        settings.data_dir / "webhook_deliveries.json")
    # Per-tenant outbound webhook host allowlist. Initialised here so
    # both subscribe-time validation and delivery-time gating see the
    # same store instance.
    from ..webhooks import host_allowlist as _wh_allow
    _wh_allow.reset_store()
    webhook_host_allowlist = _wh_allow.get_store(
        settings.data_dir / "webhook_host_allowlist.json")
    app.state.webhook_host_allowlist = webhook_host_allowlist
    # Exposed for the admin console + tests to inspect or seed the
    # delivery log without reaching into module-private state.
    app.state.webhooks_store = webhooks_store
    app.state.webhook_log_store = webhook_log_store
    drawdown_store = DrawdownGuardStore(settings.data_dir / "drawdown_guard.json")
    journal_store = JournalStore(settings.data_dir / "journal.json")
    fx_store = FxStore(settings.data_dir / "fx")
    bracket_store = BracketStore(settings.data_dir / "brackets.json")
    news_event_store = NewsEventStore(settings.data_dir / "news_events.json")
    ccy_map = TradeCurrencyMap(settings.data_dir / "trade_currency.json")
    dlq = DeadLetterQueue(settings.data_dir / "notifier_dlq.json")
    ledger_store = LedgerStore(settings.data_dir / "ledger.json")
    scaling_store = ScalingPlanStore(settings.data_dir / "scaling.json")
    api_key_store = ApiKeyStore(settings.data_dir / "api_keys.json")
    app.state.api_key_store = api_key_store
    # OIDC single sign-on. Config is admin-managed at runtime through
    # ``/admin/sso``; the login flow at ``/auth/sso/*`` mints a real
    # api key bound to the IdP-issued email and audits every step.
    oidc_store = OidcConfigStore(settings.data_dir / "sso" / "oidc.json")
    app.state.oidc_store = oidc_store
    oidc_state = OidcStateStore(
        ttl_seconds=int(os.environ.get("SIGNALCLAW_OIDC_STATE_TTL", "600"))
    )
    app.state.oidc_state = oidc_state
    # SCIM 2.0 provisioning. Bound to a dedicated bearer token (not an
    # API key) so an IdP connector cannot accidentally call the rest
    # of the API. Mints / revokes real api keys via api_key_store.
    from ..scim import (
        ScimConfigStore as _ScimCfg,
        ScimUserStore as _ScimUsr,
        ScimGroupStore as _ScimGrp,
        build_scim_user as _scim_user,
        build_scim_group as _scim_group,
        scim_error as _scim_error,
        service_provider_config as _scim_spc,
        resource_types as _scim_rts,
        parse_userName as _scim_uname,
        parse_primary_email as _scim_email,
        apply_patch_ops as _scim_patch,
        apply_group_patch_ops as _scim_group_patch,
        SCIM_LIST_SCHEMA as _SCIM_LIST,
    )
    scim_cfg_store = _ScimCfg(settings.data_dir / "scim" / "config.json")
    scim_user_store = _ScimUsr(settings.data_dir / "scim" / "users.json")
    scim_group_store = _ScimGrp(settings.data_dir / "scim" / "groups.json")
    app.state.scim_cfg_store = scim_cfg_store
    app.state.scim_user_store = scim_user_store
    app.state.scim_group_store = scim_group_store
    set_user_key_store(api_key_store)
    # MFA (TOTP) for admin actions. Enrolled keys must present a fresh
    # ``x-mfa-code`` on every admin call. When SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN=1
    # even unenrolled keys are blocked on admin routes (procurement mode).
    mfa_store = MfaStore(settings.data_dir / "mfa" / "enrollments.json")
    app.state.mfa_store = mfa_store
    # Active-session ledger. One row per (key_id, source_ip, user_agent)
    # seen in the TTL window. The middleware writes here on every
    # authenticated request; ``/admin/sessions`` reads it back so an
    # operator can spot a key in use from an unexpected IP and revoke
    # the active session (or the key behind it) in one place.
    session_ttl = int(os.environ.get(
        "SIGNALCLAW_SESSION_TTL_SECONDS", str(60 * 60 * 24 * 14)))
    session_store = SessionStore(
        settings.data_dir / "sessions.json", ttl_seconds=session_ttl)
    app.state.session_store = session_store
    # Force-logout enforcement. Revocations placed here block matching
    # (session_id, key_id) tuples in SessionTrackingMiddleware before
    # the request reaches a route. Without this layer the admin
    # "Revoke session" button only cleared the ledger row; the same
    # client recreated it on its next request.
    revocation_ttl = int(os.environ.get(
        "SIGNALCLAW_REVOCATION_TTL_SECONDS",
        str(RevocationStore.DEFAULT_TTL)))
    revocation_store = RevocationStore(
        settings.data_dir / "session_revocations.json",
        ttl_seconds=revocation_ttl)
    app.state.revocation_store = revocation_store
    # Register the session-tracking middleware now that the store
    # exists. Added here so it sits between AuditMiddleware (which
    # records request status) and the handler, picking up the
    # resolved api key without re-implementing auth.
    app.add_middleware(
        SessionTrackingMiddleware,
        store=session_store,
        revocations=revocation_store,
    )
    # Request body size guard. ASGI-level so it rejects oversized
    # payloads BEFORE Starlette buffers the body. Added here (after
    # session tracking, before security headers) so that on the
    # inbound chain it runs early: a 413 short-circuits before the
    # handler, before scope checks even touch the body. Security
    # headers still wrap the response on the outbound path.
    body_limit_store = BodyLimitStore(settings.data_dir / "body_limit.json")
    app.state.body_limit_store = body_limit_store
    _initial_body_cap = int(os.environ.get(
        "SIGNALCLAW_BODY_LIMIT_BYTES", "0") or "0")
    if _initial_body_cap > 0:
        body_limit_store.set_max_bytes(_initial_body_cap)
    app.add_middleware(
        BodyLimitMiddleware,
        store=body_limit_store,
        audit_log=audit_log,
    )
    # Static HTTP security headers (HSTS, X-Content-Type-Options,
    # X-Frame-Options, Referrer-Policy, Permissions-Policy, CSP,
    # COOP, CORP). Added LAST so it sits at the outer edge of the
    # middleware chain: every response, including 401/403 short-circuits
    # from auth/scopes, 429 from the rate limiter, and 503 from the
    # readiness probe, flows back out through it and picks up the
    # headers. Disable on plain-HTTP staging with
    # SIGNALCLAW_SECURITY_HEADERS_ENABLED=0.
    if os.environ.get("SIGNALCLAW_SECURITY_HEADERS_ENABLED", "1") == "1":
        _sec_policy = build_header_policy()
        app.state.security_headers_policy = _sec_policy
        app.add_middleware(SecurityHeadersMiddleware, policy=_sec_policy)
    else:
        app.state.security_headers_policy = {}
    _mfa_required = os.environ.get("SIGNALCLAW_MFA_REQUIRED_FOR_ADMIN", "0") == "1"

    from fastapi import Header

    def require_mfa_for_admin(
        x_api_key: str | None = Header(default=None),
        x_mfa_code: str | None = Header(default=None),
        x_mfa_recovery_code: str | None = Header(default=None),
    ) -> None:
        """Second-factor gate for admin-scoped endpoints.

        Behaviour:

        * Caller has no enrollment and MFA is not required globally:
          allowed (lets a brand-new operator enroll without being
          locked out).
        * Caller has an enrollment: must present a valid ``x-mfa-code``
          or a single-use ``x-mfa-recovery-code``. Recovery codes are
          burned on first successful use.
        * MFA required globally and caller is not enrolled: rejected
          with a clear message pointing at ``POST /mfa/enroll``.
        """
        if not x_api_key:
            return  # require_scope already returned 401 upstream
        enrolled = mfa_store.is_enrolled(x_api_key)
        if not enrolled:
            if _mfa_required:
                raise HTTPException(
                    status_code=401,
                    detail="MFA required for admin actions; enroll via POST /mfa/enroll",
                )
            return
        # Recovery code path (single-use; preferred when both headers
        # are sent so a lost-device admin can always recover).
        if x_mfa_recovery_code:
            if mfa_store.consume_recovery_code(x_api_key, x_mfa_recovery_code.strip()):
                return
            raise HTTPException(
                status_code=401,
                detail="invalid or already-used recovery code",
            )
        if not x_mfa_code:
            raise HTTPException(
                status_code=401,
                detail="missing x-mfa-code header (TOTP required for admin actions)",
            )
        if not mfa_store.verify(x_api_key, x_mfa_code.strip()):
            raise HTTPException(
                status_code=401,
                detail="invalid or replayed TOTP code",
            )

    app.state.require_mfa_for_admin = require_mfa_for_admin

    def _notifier_for(channel: str) -> Notifier | None:
        c = (channel or "").lower()
        if c == "slack":
            return SlackNotifier()
        if c == "telegram":
            return TelegramNotifier()
        if c == "discord":
            return DiscordNotifier()
        return None

    @app.get("/health")
    @app.get("/healthz")
    def health():
        # Liveness probe: cheap, no I/O. If the process can answer
        # this, Kubernetes should leave it running.
        return {"status": "ok", "ts": datetime.utcnow().isoformat()}

    @app.get("/ready")
    @app.get("/readyz")
    def ready():
        # Readiness probe: confirm the data directory is writable
        # before declaring the pod ready to take traffic. Fails closed
        # with 503 so the service mesh removes the endpoint from
        # rotation rather than serving 500s.
        ok = data_dir_ready(settings.data_dir)
        body = {"status": "ready" if ok else "not_ready",
                "data_dir": str(settings.data_dir),
                "ts": datetime.utcnow().isoformat()}
        if not ok:
            raise HTTPException(status_code=503, detail=body)
        return body

    @app.get("/.well-known/security.txt", include_in_schema=False)
    def security_txt():
        # RFC 9116 disclosure file. Returned as text/plain so a
        # vulnerability researcher can ``curl`` it. Contact and policy
        # locations are overridable per deployment.
        from fastapi.responses import PlainTextResponse
        contact = os.environ.get(
            "SIGNALCLAW_SECURITY_CONTACT",
            "mailto:security@signalclaw.local",
        )
        policy = os.environ.get(
            "SIGNALCLAW_SECURITY_POLICY_URL",
            "https://github.com/Sanjays2402/signalclaw/blob/main/SECURITY.md",
        )
        expires = os.environ.get(
            "SIGNALCLAW_SECURITY_TXT_EXPIRES",
            "2099-01-01T00:00:00.000Z",
        )
        body = (
            f"Contact: {contact}\n"
            f"Expires: {expires}\n"
            f"Policy: {policy}\n"
            "Preferred-Languages: en\n"
        )
        return PlainTextResponse(body, media_type="text/plain; charset=utf-8")

    @app.get(
        "/admin/security-headers",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_security_headers():
        """Surface the effective security header policy.

        Procurement reviewers want a single endpoint they can point a
        scanner at to confirm HSTS / CSP / etc. are configured
        correctly. The values returned here are byte-identical to
        what the middleware stamps on every response.
        """
        policy = getattr(app.state, "security_headers_policy", {}) or {}
        return {"enabled": bool(policy), "headers": policy}

    @app.get("/audit", dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def audit_tail(limit: int = 100, day: str | None = None):
        """Return recent audit events. Admin scope required.

        ``day`` is a UTC ``YYYY-MM-DD`` string; defaults to today. The
        log itself is append-only on disk under ``<data_dir>/audit/``.
        """
        limit = max(1, min(int(limit), 1000))
        return {
            "day": day or datetime.utcnow().strftime("%Y-%m-%d"),
            "events": audit_log.tail(limit=limit, day=day),
        }

    @app.get("/audit/days", dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def audit_days():
        return {"days": audit_log.list_days()}

    @app.get(
        "/audit/verify",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def audit_verify(days_back: int = 30):
        """Recompute the audit log hash-chain and report any tampering.

        Every persisted audit row carries ``prev_hash`` and
        ``entry_hash`` fields where ``entry_hash = sha256(prev_hash +
        canonical_body_json)``. This endpoint walks the last
        ``days_back`` UTC days in chronological order and recomputes
        the chain. Procurement / SOC2 reviewers can use the response
        as on-demand evidence that the audit log has not been edited.
        """
        days_back = max(1, min(int(days_back), 365))
        return audit_log.verify(days_back=days_back)

    @app.get(
        "/audit/anomalies",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def audit_anomalies(
        window_min: int = 60,
        burst_threshold: int = 10,
        fanout_threshold: int = 3,
        offhours_start_utc: int = 13,
        offhours_end_utc: int = 2,
    ):
        """Detect suspicious patterns in the recent audit log.

        Runs four detectors over the live audit JSONL (auth burst per
        IP, denied-call burst per API key, single key seen from many
        IPs, off-hours admin mutations) and returns a sorted findings
        list. The detector is a pure function of what is already on
        disk so an auditor can replay it. All inputs are validated
        and clamped to safe ranges.
        """
        from ..audit import detect_anomalies as _detect
        try:
            window_min = max(1, min(int(window_min), 24 * 60))
            burst_threshold = max(1, min(int(burst_threshold), 10_000))
            fanout_threshold = max(2, min(int(fanout_threshold), 1_000))
            offhours_start_utc = max(0, min(int(offhours_start_utc), 23))
            offhours_end_utc = max(0, min(int(offhours_end_utc), 23))
        except (TypeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"invalid parameter: {e}")
        return _detect(
            audit_log,
            window_min=window_min,
            burst_threshold=burst_threshold,
            fanout_threshold=fanout_threshold,
            offhours_start_utc=offhours_start_utc,
            offhours_end_utc=offhours_end_utc,
        )

    def _audit_filters_from_query(
        actor_label: str | None,
        actor_key_hash: str | None,
        method: str | None,
        status: int | None,
        status_min: int | None,
        path_prefix: str | None,
        path_contains: str | None,
        action: str | None,
        from_ts: str | None,
        to_ts: str | None,
    ) -> dict:
        # Centralised so /audit/search and /audit/export.csv use exactly
        # the same filter semantics. None / empty values become no-op so
        # callers can omit any param.
        return {
            "actor_label": actor_label,
            "actor_key_hash": actor_key_hash,
            "method": method,
            "status": status,
            "status_min": status_min,
            "path_prefix": path_prefix,
            "path_contains": path_contains,
            "action": action,
            "from_ts": from_ts,
            "to_ts": to_ts,
        }

    @app.get(
        "/audit/search",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def audit_search(
        actor_label: str | None = None,
        actor_key_hash: str | None = None,
        method: str | None = None,
        status: int | None = None,
        status_min: int | None = None,
        path_prefix: str | None = None,
        path_contains: str | None = None,
        action: str | None = None,
        from_ts: str | None = None,
        to_ts: str | None = None,
        days_back: int = 7,
        limit: int = 200,
        offset: int = 0,
    ):
        """Search audit events across multiple days with filters.

        Filters are AND-combined. ``days_back`` is clamped to 1..365.
        Results are newest-first. Use ``offset`` + ``limit`` to page.
        Procurement use case: "every 4xx/5xx from key X over 30 days."
        """
        if days_back is None or days_back < 1:
            days_back = 1
        if days_back > 365:
            days_back = 365
        filters = _audit_filters_from_query(
            actor_label, actor_key_hash, method, status, status_min,
            path_prefix, path_contains, action, from_ts, to_ts,
        )
        return audit_log.search(
            filters=filters,
            days_back=days_back,
            limit=limit,
            offset=offset,
        )

    @app.get(
        "/audit/export.csv",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def audit_export_csv(
        actor_label: str | None = None,
        actor_key_hash: str | None = None,
        method: str | None = None,
        status: int | None = None,
        status_min: int | None = None,
        path_prefix: str | None = None,
        path_contains: str | None = None,
        action: str | None = None,
        from_ts: str | None = None,
        to_ts: str | None = None,
        days_back: int = 30,
        max_rows: int = 100_000,
    ):
        """Stream a CSV export of matching audit events.

        Same filter semantics as ``/audit/search``. Streamed so a 30-day
        export of a busy install does not materialise in memory. The
        returned filename pins UTC date range so downloads sort.
        """
        if days_back is None or days_back < 1:
            days_back = 1
        if days_back > 365:
            days_back = 365
        if max_rows is None or max_rows < 1:
            max_rows = 1
        if max_rows > 1_000_000:
            max_rows = 1_000_000
        filters = _audit_filters_from_query(
            actor_label, actor_key_hash, method, status, status_min,
            path_prefix, path_contains, action, from_ts, to_ts,
        )
        today = datetime.utcnow().strftime("%Y-%m-%d")
        filename = f"audit-export-{today}-last{int(days_back)}d.csv"
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            audit_log.iter_csv(filters=filters, days_back=int(days_back), max_rows=int(max_rows)),
            media_type="text/csv; charset=utf-8",
            headers={
                "content-disposition": f'attachment; filename="{filename}"',
                "cache-control": "no-store",
            },
        )

    # --- user-managed API keys -------------------------------------------
    # These require the ``admin`` scope so a read-only key cannot mint a
    # trade-scoped key for itself. The dev fallback key has admin; in
    # production set SIGNALCLAW_API_KEYS_JSON with an admin-scoped key.
    @app.get("/admin/keys", dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_list():
        return {"keys": [k.to_public() for k in api_key_store.list()]}

    @app.post("/admin/keys", dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_create(body: dict):
        from ..api_keys import ROLES, ROLE_SCOPES, DEFAULT_ROLE
        label = str(body.get("label") or "").strip()
        # RBAC role. Defaults to ``member`` (read+trade) so existing
        # callers that do not pass a role keep their prior behaviour.
        role_in = (body.get("role") or DEFAULT_ROLE)
        if not isinstance(role_in, str) or role_in.strip().lower() not in ROLES:
            raise HTTPException(
                400, f"role must be one of {sorted(ROLES)}")
        role = role_in.strip().lower()
        scopes_in = body.get("scopes") or ["read"]
        if not isinstance(scopes_in, list) or not all(isinstance(s, str) for s in scopes_in):
            raise HTTPException(400, "scopes must be a list of strings")
        # Scope grant is capped by the role's permitted set. ``admin``
        # scope is allowed only when the role itself carries admin
        # (owner / admin). A viewer key can never end up with trade.
        allowed = ROLE_SCOPES[role]
        scopes = [s for s in scopes_in if s in allowed]
        # Roles that carry the admin scope should always have it on the
        # minted key, even if the caller did not pass it in scopes_in.
        # Members and viewers can never hold admin.
        if "admin" in allowed:
            scopes.append("admin")
        if not scopes:
            # always grant at least read; otherwise the key is useless.
            scopes = sorted({"read"} & allowed) or ["read"]
        expires_in = body.get("expires_in_seconds")
        ttl: int | None = None
        if expires_in is not None:
            try:
                ttl = int(expires_in)
            except (TypeError, ValueError):
                raise HTTPException(400, "expires_in_seconds must be an integer")
            if ttl < 0 or ttl > 365 * 24 * 3600:
                raise HTTPException(
                    400, "expires_in_seconds must be between 0 and 31536000")
        rec, secret = api_key_store.create(
            label=label, scopes=scopes, expires_in_seconds=ttl, role=role)
        # Optional ip_allowlist on create. Validated by the store helper;
        # invalid CIDRs return 400 without leaving a half-configured key
        # because we revoke the just-minted key on failure.
        cidrs_in = body.get("ip_allowlist")
        if cidrs_in is not None:
            if not isinstance(cidrs_in, list) or not all(isinstance(s, str) for s in cidrs_in):
                api_key_store.revoke(rec.id)
                raise HTTPException(400, "ip_allowlist must be a list of strings")
            try:
                rec = api_key_store.set_ip_allowlist(rec.id, cidrs_in) or rec
            except ValueError as exc:
                api_key_store.revoke(rec.id)
                raise HTTPException(400, str(exc))
        # Optional path_allowlist on create. Same fail-closed semantics
        # as ip_allowlist: invalid input revokes the just-minted key so
        # we never persist a half-configured credential.
        paths_in = body.get("path_allowlist")
        if paths_in is not None:
            if not isinstance(paths_in, list) or not all(isinstance(s, str) for s in paths_in):
                api_key_store.revoke(rec.id)
                raise HTTPException(400, "path_allowlist must be a list of strings")
            try:
                rec = api_key_store.set_path_allowlist(rec.id, paths_in) or rec
            except ValueError as exc:
                api_key_store.revoke(rec.id)
                raise HTTPException(400, str(exc))
        out = rec.to_public()
        out["secret"] = secret  # one-time reveal
        return out

    @app.put("/admin/keys/{key_id}/ip-allowlist",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_allowlist(key_id: str, body: dict):
        cidrs = body.get("ip_allowlist")
        if cidrs is None:
            cidrs = []
        if not isinstance(cidrs, list) or not all(isinstance(s, str) for s in cidrs):
            raise HTTPException(400, "ip_allowlist must be a list of strings")
        try:
            updated = api_key_store.set_ip_allowlist(key_id, cidrs)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.put("/admin/keys/{key_id}/path-allowlist",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_path_allowlist(key_id: str, body: dict):
        """Replace the per-key path-prefix allowlist.

        Body: ``{"path_allowlist": ["/v1/runs", "/picks"]}``. Pass an
        empty list to clear the policy (the key may hit any path its
        scopes allow). Each entry must start with ``/`` and is matched
        as a segment-bounded prefix: ``/v1/runs`` allows ``/v1/runs``
        and ``/v1/runs/abc`` but not ``/v1/runsearch``. Maximum 64
        entries; invalid input returns 400 with a structured error so
        a UI can surface the offending entry.
        """
        paths = body.get("path_allowlist") if body else None
        if paths is None:
            paths = []
        if not isinstance(paths, list) or not all(isinstance(s, str) for s in paths):
            raise HTTPException(400, "path_allowlist must be a list of strings")
        try:
            updated = api_key_store.set_path_allowlist(key_id, paths)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.put("/admin/keys/{key_id}/expiry",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_expiry(key_id: str, body: dict):
        """Set or clear a key's hard expiry.

        Body: ``{"expires_in_seconds": <int>}``. Use ``0`` or ``null``
        to clear an existing expiry. Maximum is one year so a stale UI
        value cannot mint a multi-decade credential. SOC2-style hygiene:
        keys should not live forever.
        """
        raw = body.get("expires_in_seconds", None) if body else None
        ttl: int | None = None
        if raw is not None:
            try:
                ttl = int(raw)
            except (TypeError, ValueError):
                raise HTTPException(400, "expires_in_seconds must be an integer")
            if ttl < 0 or ttl > 365 * 24 * 3600:
                raise HTTPException(
                    400, "expires_in_seconds must be between 0 and 31536000")
        updated = api_key_store.set_expiry(key_id, ttl)
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.delete("/admin/keys/{key_id}", dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_revoke(key_id: str):
        ok = api_key_store.revoke(key_id)
        if not ok:
            raise HTTPException(404, "key not found")
        return {"revoked": key_id}

    @app.post("/admin/keys/{key_id}/suspend",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_suspend(key_id: str, body: dict | None = None):
        """Reversibly disable an API key.

        Body (optional): ``{"reason": "<=200 chars"}``. Different from
        ``DELETE /admin/keys/{id}`` (revoke), which is a permanent
        tombstone. Suspended keys fail auth immediately (next request
        returns 401) but keep their scopes, role, ip-allowlist, expiry,
        and forensic last-use fingerprint so an operator can resume
        them in one click after the incident clears. The mutation is
        captured by AuditMiddleware (actor / IP / target / timestamp).
        """
        b = body or {}
        reason = b.get("reason")
        if reason is not None and not isinstance(reason, str):
            raise HTTPException(400, "reason must be a string")
        updated = api_key_store.suspend(key_id, reason=reason)
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.post("/admin/keys/{key_id}/resume",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_resume(key_id: str):
        """Lift a prior :func:`admin_keys_suspend`.

        Clears all ``suspended_*`` fields so the key returns to its
        pre-suspension posture. No-op on rows that are not suspended.
        Refuses revoked rows. Returns 404 if the key is missing.
        """
        updated = api_key_store.resume(key_id)
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.put("/admin/keys/{key_id}/role",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_role(key_id: str, body: dict):
        """Change an API key's RBAC role.

        Body: ``{"role": "owner|admin|member|viewer"}``. Re-caps the
        stored scopes to the new role, so a downgrade immediately
        revokes any privileges the role no longer permits.
        """
        role = (body or {}).get("role")
        if not isinstance(role, str):
            raise HTTPException(400, "role must be a string")
        try:
            updated = api_key_store.set_role(key_id, role)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.put("/admin/keys/{key_id}/label",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_label(key_id: str, body: dict):
        """Rename an API key without rotating its secret.

        Body: ``{"label": "new name"}``. Trims and clamps to 80 chars;
        rejects empty labels with a 400 so the inventory never loses a
        human-readable name. Admin scope + MFA gated like every other
        mutating admin route; the audit middleware records the actor,
        path, and request id automatically.
        """
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        label = body.get("label")
        if not isinstance(label, str):
            raise HTTPException(400, "label must be a string")
        try:
            updated = api_key_store.set_label(key_id, label)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    # --- Access reviews (SOC2 CC6.3 / ISO 27001 A.9.2.5) ---------------
    # Every live API key must be re-attested by an admin on a cadence
    # (default 90 days). The two endpoints below let an operator record
    # an attestation and list every key that is overdue, so the access
    # review program is enforceable and auditable from one place. All
    # writes pass through AuditMiddleware so the actor, target key id,
    # and timestamp land in the immutable audit log automatically.
    # ----- Expiry watchlist -------------------------------------------------
    # SOC2 CC6.1 + ISO 27001 A.9.2.6 require time-bound credentials and
    # proactive rotation. Expired keys are already rejected at auth, but
    # the admin needs a queue so they can rotate *before* the lapse takes
    # automation down at 03:00 on a Sunday. This endpoint mirrors the
    # Next.js /api/admin/keys/expiring shape so a single dashboard can
    # poll either surface.
    @app.get(
        "/admin/keys/expiring",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_keys_expiring(within_days: int = 30):
        from ..api_keys import (
            DEFAULT_EXPIRY_WARNING_DAYS,
            MAX_EXPIRY_WARNING_DAYS,
            expiry_bucket,
            seconds_until_expiry,
        )
        if not isinstance(within_days, int) or within_days < 1 or within_days > MAX_EXPIRY_WARNING_DAYS:
            raise HTTPException(
                400,
                {
                    "scope": "bad_within_days",
                    "message": f"within_days must be an integer between 1 and {MAX_EXPIRY_WARNING_DAYS}",
                },
            )
        rows = api_key_store.list_expiring(within_days)
        out = []
        for r in rows:
            d = r.to_public()
            secs = seconds_until_expiry(r) or 0
            d["expires_in_seconds"] = secs
            d["expires_in_days"] = secs // 86400
            d["bucket"] = expiry_bucket(r)
            out.append(d)
        counts = {
            "critical": sum(1 for k in out if k["bucket"] == "critical"),
            "soon": sum(1 for k in out if k["bucket"] == "soon"),
            "upcoming": sum(1 for k in out if k["bucket"] == "upcoming"),
        }
        return {
            "window_days": within_days,
            "default_window_days": DEFAULT_EXPIRY_WARNING_DAYS,
            "count": len(out),
            "counts": counts,
            "keys": out,
        }

    # SOC2 CC6.1 / ISO 27001 A.9.2.5: long-silent credentials are a
    # liability. A key that has not authenticated in months should be
    # reviewed and (almost always) revoked. This endpoint mirrors the
    # /admin/keys/expiring shape so the admin console can poll a single
    # set of watchlist surfaces. Dormancy is measured from
    # ``last_used_at`` (or ``created_at`` for never-used keys).
    @app.get(
        "/admin/keys/dormant",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_keys_dormant(within_days: int = 30):
        from ..api_keys import (
            DEFAULT_DORMANT_WINDOW_DAYS,
            MAX_DORMANT_WINDOW_DAYS,
            dormancy_bucket,
            seconds_since_last_use,
        )
        from datetime import datetime, timezone
        if not isinstance(within_days, int) or within_days < 1 or within_days > MAX_DORMANT_WINDOW_DAYS:
            raise HTTPException(
                400,
                {
                    "scope": "bad_within_days",
                    "message": f"within_days must be an integer between 1 and {MAX_DORMANT_WINDOW_DAYS}",
                },
            )
        now = datetime.now(timezone.utc)
        rows = api_key_store.list_dormant(within_days, now=now)
        out = []
        for r in rows:
            d = r.to_public()
            secs = seconds_since_last_use(r, now=now) or 0
            d["silent_seconds"] = secs
            d["silent_days"] = secs // 86400
            d["bucket"] = dormancy_bucket(r, now=now)
            d["never_used"] = not bool(getattr(r, "last_used_at", None))
            out.append(d)
        counts = {
            "quiet": sum(1 for k in out if k["bucket"] == "quiet"),
            "dormant": sum(1 for k in out if k["bucket"] == "dormant"),
            "abandoned": sum(1 for k in out if k["bucket"] == "abandoned"),
            "never_used": sum(1 for k in out if k["never_used"]),
        }
        return {
            "window_days": within_days,
            "default_window_days": DEFAULT_DORMANT_WINDOW_DAYS,
            "count": len(out),
            "counts": counts,
            "keys": out,
            "generated_at": now.isoformat().replace("+00:00", "Z"),
        }

    # The control inventory enumerates every enterprise policy with a
    # live status. Surface this one too so a SOC2 reviewer can see at a
    # glance that proactive expiry monitoring is wired and enforcing.
    @app.get(
        "/admin/keys/review-overdue",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_keys_review_overdue():
        """List API keys whose access review is past due.

        Used by the admin console queue and the SOC2 evidence pack to
        prove that periodic access reviews are being executed on the
        configured cadence.
        """
        rows = api_key_store.list_review_overdue()
        return {"keys": [k.to_public() for k in rows], "count": len(rows)}

    @app.post(
        "/admin/keys/{key_id}/review",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_keys_review(
        key_id: str,
        request: Request,
        body: dict | None = None,
    ):
        """Record an access-review attestation for ``key_id``.

        Stamps ``last_reviewed_at`` to now and ``last_reviewed_by`` to
        the calling key's prefix so an auditor can trace each
        attestation back to a person. Optional ``interval_days``
        (1..365) updates the review cadence in the same call so an
        admin can extend or tighten a key's window without a second
        round trip.
        """
        b = body or {}
        # Identify the reviewer from the active credential. We never log
        # the raw secret; the prefix is enough to disambiguate keys in
        # the audit trail and is already shown in /admin/keys.
        actor_key = request.headers.get("x-api-key", "") or ""
        reviewer = (actor_key[:12] + "...") if actor_key else None
        if "interval_days" in b and b.get("interval_days") is not None:
            try:
                api_key_store.set_review_interval(key_id, b.get("interval_days"))
            except ValueError as exc:
                raise HTTPException(400, str(exc))
        updated = api_key_store.attest_review(key_id, reviewer=reviewer)
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.put(
        "/admin/keys/{key_id}/review-interval",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_keys_set_review_interval(key_id: str, body: dict):
        """Change the access-review cadence for a key.

        Body: ``{"days": <1..365>}``. Does not record an attestation;
        use ``POST /admin/keys/{id}/review`` for that.
        """
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        days = body.get("days")
        try:
            updated = api_key_store.set_review_interval(key_id, days)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if updated is None:
            raise HTTPException(404, "key not found")
        return updated.to_public()

    @app.post("/admin/keys/{key_id}/rotate",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_rotate(key_id: str, body: dict | None = None):
        """Mint a new secret for an existing key.

        Body may include ``grace_seconds`` (0..604800) to keep the old
        secret valid for a bounded overlap so live integrations can roll
        over without downtime. ``grace_seconds=0`` (the default) makes
        the previous secret stop working immediately.
        """
        b = body or {}
        try:
            grace = int(b.get("grace_seconds", 0) or 0)
        except (TypeError, ValueError):
            raise HTTPException(400, "grace_seconds must be an integer")
        if grace < 0 or grace > 7 * 24 * 3600:
            raise HTTPException(400, "grace_seconds must be between 0 and 604800")
        result = api_key_store.rotate(key_id, grace_seconds=grace)
        if result is None:
            raise HTTPException(404, "key not found")
        rec, secret = result
        out = rec.to_public()
        out["secret"] = secret  # one-time reveal
        out["grace_seconds"] = grace
        return out

    # --- Plans + monthly usage (quotas) ---------------------------------
    # Enterprise procurement asks two questions repeatedly: how do you
    # cap a customer's usage, and how do we see what they consumed for
    # billing. These endpoints answer both. ``GET /admin/plans`` lists
    # the configured catalogue; ``PUT /admin/keys/{id}/plan`` assigns
    # a plan to a key; ``GET /admin/usage`` returns this month's call
    # count per key (and the plan it is on). All writes are audited
    # automatically because the request flows through AuditMiddleware.
    @app.get("/admin/plans",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_plans_list():
        return {
            "plans": [p.to_public() for p in quota_store.plans()],
            "default_plan_id": quota_store.default_plan_id(),
        }

    @app.put("/admin/keys/{key_id}/plan",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_keys_set_plan(key_id: str, body: dict):
        """Assign a billing plan to a key.

        Body: ``{"plan": "free|pro|enterprise"}``. The plan key id is
        stored against the API key's stable id so usage and the cap
        survive secret rotation. Returns the resolved plan plus the
        key's current month usage so the admin console can render
        the new state without a second probe.
        """
        plan_id = (body or {}).get("plan")
        if not isinstance(plan_id, str) or not plan_id:
            raise HTTPException(400, "plan must be a non-empty string")
        # Validate the key id exists (and is not revoked) so we do not
        # silently bill against a phantom row.
        stored = next((k for k in api_key_store.list()
                       if k.id == key_id and not k.revoked), None)
        if stored is None:
            raise HTTPException(404, "key not found")
        scoped_id = f"key:{key_id}"
        try:
            plan = quota_store.set_plan(scoped_id, plan_id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        used = quota_store.usage(scoped_id)
        remaining, _ = quota_store.remaining(scoped_id)
        return {
            "key_id": key_id,
            "plan": plan.to_public(),
            "usage": int(used),
            "remaining": int(remaining),
        }

    @app.get("/admin/usage",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_usage_summary():
        """Current-month usage for every known key.

        Includes revoked keys (their historical counters are still
        useful for invoicing the period in which they were active).
        Rows for keys with no recorded calls this month are returned
        with ``used=0`` so the admin console can render the full
        roster without a join.
        """
        from ..quotas import month_key as _mk
        current = _mk()
        rows = []
        seen: set[str] = set()
        for k in api_key_store.list():
            scoped = f"key:{k.id}"
            seen.add(scoped)
            plan = quota_store.plan_for(scoped)
            used = quota_store.usage(scoped, current)
            remaining, _ = quota_store.remaining(scoped, current)
            rows.append({
                "key_id": k.id,
                "label": k.label,
                "revoked": bool(k.revoked),
                "plan": plan.to_public(),
                "used": int(used),
                "remaining": int(remaining),
                "month": current,
            })
        # Env-configured keys do not appear in api_key_store; surface
        # any usage rows we tracked against them so an operator can
        # still see who is calling the API.
        for scoped_id, by_month in quota_store.usage_all().items():
            if scoped_id in seen:
                continue
            plan = quota_store.plan_for(scoped_id)
            used = int(by_month.get(current, 0))
            remaining, _ = quota_store.remaining(scoped_id, current)
            rows.append({
                "key_id": scoped_id,
                "label": "",
                "revoked": False,
                "plan": plan.to_public(),
                "used": used,
                "remaining": int(remaining),
                "month": current,
            })
        return {"month": current, "keys": rows}

    @app.get("/admin/usage/{key_id}",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_usage_one(key_id: str):
        scoped = f"key:{key_id}"
        plan = quota_store.plan_for(scoped)
        all_usage = quota_store.usage_all().get(scoped, {})
        from ..quotas import month_key as _mk
        current = _mk()
        remaining, _ = quota_store.remaining(scoped, current)
        return {
            "key_id": key_id,
            "plan": plan.to_public(),
            "current_month": current,
            "used": int(all_usage.get(current, 0)),
            "remaining": int(remaining),
            "history": {m: int(v) for m, v in sorted(all_usage.items())},
        }

    # --- Caller-facing self-usage ---------------------------------------
    # Every customer dashboard wants to render "you have used N of M
    # calls this month, resets at X" without ever needing an admin
    # scope or pulling /admin/usage (which lists every tenant). This
    # endpoint scopes strictly to the caller's own key id resolved
    # from x-api-key and is the canonical billing-self-service surface.
    # Cross-tenant isolation is guaranteed because the key id used to
    # look up the quota row is derived from the secret the caller
    # presented; there is no path that lets a query parameter or
    # body field redirect the lookup to another tenant.
    @app.get("/usage/me", dependencies=[Depends(require_api_key)])
    def usage_me(x_api_key: str | None = Header(default=None)):
        from ..quotas.middleware import _key_id_for as _qkid
        from ..quotas import month_key as _mk, seconds_until_next_month
        scoped = _qkid(x_api_key)
        if scoped is None:
            # require_api_key already rejected anonymous callers, so
            # the only way to land here without a scoped id is an env
            # key that the quota module cannot resolve. Treat as an
            # explicit unsupported case rather than a silent 200.
            raise HTTPException(404, "caller key is not tracked for usage")
        plan = quota_store.plan_for(scoped)
        all_usage = quota_store.usage_all().get(scoped, {})
        current = _mk()
        used = int(all_usage.get(current, 0))
        remaining, _ = quota_store.remaining(scoped, current)
        reset_seconds = seconds_until_next_month()
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        reset_at = (_dt.now(_tz.utc) + _td(seconds=reset_seconds)).strftime(
            "%Y-%m-%dT%H:%M:%SZ")
        return {
            "key_id": scoped,
            "plan": plan.to_public(),
            "current_month": current,
            "used": used,
            "remaining": int(remaining),
            "reset_at": reset_at,
            "reset_in_seconds": int(reset_seconds),
            "history": {m: int(v) for m, v in sorted(all_usage.items())},
        }

    # --- Active sessions ------------------------------------------------
    # Resolve the calling key into a short, audit-friendly label so a
    # revocation row records WHO placed the block. Falls back to the
    # first chars of the secret hash for legacy env-only keys so the
    # actor field is never blank.
    def _actor_label(x_api_key: str | None) -> str:
        if not x_api_key:
            return "unknown"
        try:
            store_ = getattr(app.state, "api_key_store", None)
            if store_ is not None:
                stored = store_.lookup(x_api_key)
                if stored is not None:
                    return f"{stored.id}:{getattr(stored, 'label', '') or ''}".strip(":")
        except Exception:
            pass
        try:
            from ..api_keys import _hash as _hk
            return "env:" + _hk(x_api_key)[:12]
        except Exception:
            return "unknown"

    # An enterprise admin needs to see, in one place, which API keys are
    # currently active, from which IPs, with which clients, and when
    # they were last used. They also need a one-click way to kill a
    # session that looks wrong without nuking the underlying key.
    @app.get("/admin/sessions",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_list():
        live = [s.to_public() for s in session_store.list()]
        active_rev = {r.session_id for r in revocation_store.list()
                      if r.scope == "session"}
        for row in live:
            row["revoked"] = row["id"] in active_rev
        return {
            "sessions": live,
            "revocations": [asdict(r) for r in revocation_store.list()],
            "revocation_stats": revocation_store.stats(),
        }

    @app.delete("/admin/sessions/{session_id}",
                dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_revoke(
        session_id: str,
        x_api_key: str | None = Header(default=None),
    ):
        # Locate the live row so we know which key_id to bind the
        # revocation to. If the row is missing (TTL pruned or never
        # seen) we still record the block keyed by session_id alone.
        target = next(
            (s for s in session_store.list() if s.id == session_id), None)
        if target is None:
            raise HTTPException(404, "session not found")
        actor = _actor_label(x_api_key)
        revocation_store.revoke_session(
            session_id=session_id,
            key_id=target.key_id,
            reason="admin_revoke",
            revoked_by=actor,
        )
        session_store.revoke(session_id)
        return {
            "revoked": session_id,
            "key_id": target.key_id,
            "enforced": True,
        }

    @app.post("/admin/sessions/{session_id}/restore",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_restore(session_id: str):
        """Lift a previously placed session-scope revocation. The
        underlying ledger row is recreated by the next request from
        that client; the operator just needs to clear the block.
        """
        cleared = revocation_store.clear_session(session_id)
        if not cleared:
            raise HTTPException(404, "no active revocation")
        return {"restored": session_id}

    @app.post("/admin/sessions/revoke-key/{key_id}",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_revoke_key(
        key_id: str,
        x_api_key: str | None = Header(default=None),
    ):
        """Force-logout every active session for a key AND block any
        future session from that key for the configured revocation
        TTL. Does not delete the underlying credential, by design: an
        operator can lift the block via ``/restore-key`` once the
        incident is resolved, or call ``DELETE /admin/keys/{key_id}``
        to invalidate the credential permanently.
        """
        actor = _actor_label(x_api_key)
        revocation_store.revoke_key(
            key_id=key_id,
            reason="admin_revoke_key",
            revoked_by=actor,
        )
        n = session_store.revoke_for_key(key_id)
        return {
            "revoked_key": key_id,
            "sessions_removed": int(n),
            "enforced": True,
        }

    @app.post("/admin/sessions/restore-key/{key_id}",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_restore_key(key_id: str):
        cleared = revocation_store.clear_key(key_id)
        if not cleared:
            raise HTTPException(404, "no active revocation")
        return {"restored_key": key_id}

    @app.post("/admin/sessions/revoke-all",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_sessions_revoke_all(
        x_api_key: str | None = Header(default=None),
    ):
        """Force-logout every tracked session and place a key-scope
        revocation on each underlying key so the next request from
        any of them is rejected with HTTP 401. Use after a suspected
        compromise. The underlying keys remain valid (revoke them
        separately via ``DELETE /admin/keys/{key_id}`` if needed).

        The caller's own key is exempted from the block so the operator
        cannot lock themselves out mid-incident.
        """
        actor = _actor_label(x_api_key)
        # Resolve the caller's own key_id so we can skip it.
        self_key_id = ""
        try:
            store_ = getattr(app.state, "api_key_store", None)
            if store_ is not None and x_api_key:
                stored = store_.lookup(x_api_key)
                if stored is not None:
                    self_key_id = stored.id
            if not self_key_id and x_api_key:
                from ..api_keys import _hash as _hk
                self_key_id = "env:" + _hk(x_api_key)[:12]
        except Exception:
            self_key_id = ""
        affected_keys: set[str] = set()
        for s in session_store.list():
            if s.key_id and s.key_id != self_key_id:
                affected_keys.add(s.key_id)
        for key_id in affected_keys:
            revocation_store.revoke_key(
                key_id=key_id,
                reason="admin_revoke_all",
                revoked_by=actor,
            )
        n = session_store.revoke_all()
        return {
            "sessions_removed": int(n),
            "keys_blocked": len(affected_keys),
            "caller_exempted": self_key_id,
            "enforced": True,
        }

    # --- Workspace network policy (global IP allowlist) -----------------
    # Surfaced under /admin/network-policy so the admin console can
    # manage it. Audited automatically by AuditMiddleware because the
    # PUT mutates auth-gating state.
    @app.get("/admin/network-policy",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_network_policy_get():
        p = network_policy_store.get()
        return {
            "enabled": p.enabled,
            "cidrs": list(p.cidrs),
            "updated_at": p.updated_at,
            "updated_by": p.updated_by,
            "max_cidrs": MAX_CIDRS,
        }

    @app.put("/admin/network-policy",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_network_policy_put(
        body: dict,
        x_api_key: str | None = Header(default=None),
    ):
        """Replace the workspace IP allowlist.

        Body shape: ``{"enabled": bool, "cidrs": ["10.0.0.0/8", ...]}``.
        Refuses ``enabled=true`` with no CIDRs to prevent lockout.
        Bare IPs are accepted and promoted to host networks.
        """
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        enabled = bool(body.get("enabled", False))
        raw_cidrs = body.get("cidrs") or []
        if not isinstance(raw_cidrs, list):
            raise HTTPException(400, "cidrs must be a list of strings")
        # Validate up front so we return 400 on bad input rather than 500.
        try:
            for c in raw_cidrs:
                if not isinstance(c, str):
                    raise ValueError("cidrs entries must be strings")
                normalise_cidr(c)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        actor = (x_api_key or "")[:12] or "admin"
        try:
            p = network_policy_store.set(
                enabled=enabled, cidrs=raw_cidrs, actor=actor)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        log.info("network_policy.updated",
                 enabled=p.enabled, cidr_count=len(p.cidrs))
        return {
            "enabled": p.enabled,
            "cidrs": list(p.cidrs),
            "updated_at": p.updated_at,
            "updated_by": p.updated_by,
        }

    # --- Workspace CORS policy (browser-origin allowlist) ---------------
    # Procurement reviews block any API that ships allow_origins=["*"].
    # This is the admin surface that controls which web origins the
    # dashboard accepts. Mutations are audited by AuditMiddleware.
    @app.get("/admin/cors-policy",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_cors_policy_get():
        p = cors_policy_store.get()
        d = p.to_public()
        return d

    @app.put("/admin/cors-policy",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_cors_policy_put(
        body: dict,
        x_api_key: str | None = Header(default=None),
    ):
        """Replace the CORS policy.

        Body shape: ``{"enabled": bool, "origins": ["https://app.x.com"],
        "allow_credentials": bool}``. Refuses ``enabled=true`` with an
        empty allowlist so the workspace cannot accidentally regress to
        a permissive default.
        """
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        enabled = body.get("enabled", None)
        origins = body.get("origins", None)
        allow_credentials = body.get("allow_credentials", None)
        if origins is not None:
            if not isinstance(origins, list):
                raise HTTPException(400, "origins must be a list of strings")
            try:
                for o in origins:
                    if not isinstance(o, str):
                        raise ValueError("origins entries must be strings")
                    normalise_origin(o)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
        actor = (x_api_key or "")[:12] or "admin"
        try:
            p = cors_policy_store.set_policy(
                enabled=None if enabled is None else bool(enabled),
                origins=origins,
                allow_credentials=(
                    None if allow_credentials is None
                    else bool(allow_credentials)
                ),
                actor=actor,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        log.info("cors_policy.updated",
                 enabled=p.enabled, origin_count=len(p.origins),
                 allow_credentials=p.allow_credentials)
        return p.to_public()

    # --- Request body size limit -------------------------------------
    # Admin-managed cap enforced by BodyLimitMiddleware. PUT writes
    # are audited automatically by AuditMiddleware because the path
    # matches /admin/*.
    @app.get("/admin/body-limit",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_body_limit_get():
        cfg = body_limit_store.get()
        return {
            "max_bytes": cfg.max_bytes,
            "min_bytes": MIN_LIMIT_BYTES,
            "max_allowed_bytes": MAX_LIMIT_BYTES,
            "default_bytes": DEFAULT_LIMIT_BYTES,
        }

    @app.put("/admin/body-limit",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_body_limit_put(body: dict):
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        if "max_bytes" not in body:
            raise HTTPException(400, "max_bytes is required")
        try:
            requested = int(body["max_bytes"])
        except (TypeError, ValueError):
            raise HTTPException(400, "max_bytes must be an integer")
        if requested < MIN_LIMIT_BYTES or requested > MAX_LIMIT_BYTES:
            raise HTTPException(
                400,
                f"max_bytes must be between {MIN_LIMIT_BYTES} and {MAX_LIMIT_BYTES}",
            )
        cfg = body_limit_store.set_max_bytes(requested)
        log.info("body_limit.updated", max_bytes=cfg.max_bytes)
        return {
            "max_bytes": cfg.max_bytes,
            "min_bytes": MIN_LIMIT_BYTES,
            "max_allowed_bytes": MAX_LIMIT_BYTES,
            "default_bytes": DEFAULT_LIMIT_BYTES,
        }

    @app.get("/disclaimer")
    def disclaimer():
        return {"text": "SignalClaw is NOT financial advice. See FINANCIAL_DISCLAIMER.md."}

    # --- MFA (TOTP) for admin actions ------------------------------------
    # Anyone with a valid API key can enroll their own key. Disabling
    # requires the admin scope (so an admin can recover from a lost
    # device by issuing a new key + disabling MFA on the compromised
    # one). All four endpoints are audit-logged via the existing
    # AuditMiddleware because they mutate auth state.
    @app.get("/mfa/status", dependencies=[Depends(require_api_key)])
    def mfa_status(x_api_key: str | None = Header(default=None)):
        rec = mfa_store.get(x_api_key or "")
        return {
            "enrolled": bool(rec and rec.confirmed),
            "pending": bool(rec and not rec.confirmed),
            "required_for_admin": _mfa_required,
            "recovery_codes_remaining": (
                len(rec.recovery_hashes) if (rec and rec.confirmed) else 0
            ),
        }

    @app.post("/mfa/enroll", dependencies=[Depends(require_api_key)])
    def mfa_enroll(body: dict | None = None,
                   x_api_key: str | None = Header(default=None)):
        """Begin TOTP enrollment for the calling key.

        Returns the base32 secret and an ``otpauth://`` provisioning
        URI exactly once. The UI should render the URI as a QR code
        and then call ``POST /mfa/confirm`` with the first 6-digit
        code from the authenticator app.
        """
        if not x_api_key:
            raise HTTPException(401, "missing x-api-key")
        label = ""
        if body and isinstance(body, dict):
            label = str(body.get("label") or "").strip()[:64]
        enr = mfa_store.begin_enroll(x_api_key, label=label)
        if enr.confirmed:
            raise HTTPException(
                409,
                "MFA already enrolled for this key; call POST /mfa/disable first",
            )
        uri = provisioning_uri(
            enr.secret_b32,
            label=enr.label or "signalclaw-key",
        )
        return {
            "secret": enr.secret_b32,
            "otpauth_uri": uri,
            "algorithm": "SHA1",
            "digits": 6,
            "period_seconds": 30,
        }

    @app.post("/mfa/confirm", dependencies=[Depends(require_api_key)])
    def mfa_confirm(body: dict,
                    x_api_key: str | None = Header(default=None)):
        code = str((body or {}).get("code") or "").strip()
        if not code:
            raise HTTPException(400, "code is required")
        if not mfa_store.confirm(x_api_key or "", code):
            raise HTTPException(400, "invalid TOTP code or no pending enrollment")
        # Mint the first batch of recovery codes. Plaintext is returned
        # exactly once: the UI must surface a "save these now" screen
        # because the server only persists their hashes.
        recovery = mfa_store.issue_recovery_codes(x_api_key or "") or []
        return {
            "enrolled": True,
            "recovery_codes": recovery,
            "recovery_codes_remaining": len(recovery),
        }

    @app.post("/mfa/recovery-codes/regenerate",
              dependencies=[Depends(require_scope("admin")),
                            Depends(require_mfa_for_admin)])
    def mfa_regenerate_recovery_codes(
        x_api_key: str | None = Header(default=None),
    ):
        """Replace the caller's recovery codes with a fresh batch.

        MFA-gated (TOTP or an unused recovery code) so a stolen API
        key alone cannot burn through all recovery codes silently.
        Returns the new plaintext codes exactly once; previous codes
        are invalidated immediately.
        """
        codes = mfa_store.issue_recovery_codes(x_api_key or "")
        if codes is None:
            raise HTTPException(400, "MFA is not enrolled for this key")
        return {
            "recovery_codes": codes,
            "recovery_codes_remaining": len(codes),
        }

    @app.post("/mfa/disable",
              dependencies=[Depends(require_scope("admin")),
                            Depends(require_mfa_for_admin)])
    def mfa_disable(body: dict | None = None,
                    x_api_key: str | None = Header(default=None)):
        """Remove the calling key's MFA enrollment.

        Itself MFA-gated so a stolen API key alone cannot turn off MFA.
        Recovery path for a lost device: issue a new admin key on the
        server (env config), then call this endpoint with the new key.
        """
        ok = mfa_store.disable(x_api_key or "")
        return {"disabled": ok}

    # Public, unauthenticated demo of the regime classifier. Locked to a
    # small allowlist of well-known liquid tickers so a first-time visitor
    # can see real model output without setup. Per-IP rate limiting still
    # applies via PerIPRateLimitMiddleware.
    PUBLIC_DEMO_TICKERS = {"SPY", "QQQ", "IWM", "TLT", "GLD", "BTC-USD"}

    @app.get("/public/regime/demo")
    def public_regime_demo(ticker: str = "SPY", lookback_days: int = 504):
        """Public regime classification for a fixed allowlist of tickers.

        Returns the same shape as /regime/series but without auth so the
        landing page can show a live demo to first-time visitors.
        """
        t = (ticker or "").upper().strip()
        if t not in PUBLIC_DEMO_TICKERS:
            raise HTTPException(400, f"ticker must be one of: {sorted(PUBLIC_DEMO_TICKERS)}")
        try:
            lookback_days = max(120, min(int(lookback_days), 1260))
        except (TypeError, ValueError):
            raise HTTPException(400, "lookback_days must be an integer")
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period="5y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        close = df["close"].dropna()
        if len(close) < 260:
            raise HTTPException(422, "insufficient history")
        labels = regime_series(close)
        tail = close.tail(lookback_days)
        tail_labels = labels.reindex(tail.index)
        dates = [str(d.date() if hasattr(d, "date") else d) for d in tail.index]
        closes = [float(v) for v in tail.values]
        regs = [str(v) if v == v and v is not None else None for v in tail_labels.values]
        counts: dict[str, int] = {}
        for r in regs:
            if r:
                counts[r] = counts.get(r, 0) + 1
        snap = detect_regime(close)
        return {
            "ticker": t,
            "dates": dates,
            "close": closes,
            "regime": regs,
            "counts": counts,
            "snapshot": snap.to_dict() if snap else None,
            "allowlist": sorted(PUBLIC_DEMO_TICKERS),
            "disclaimer": "SignalClaw is NOT financial advice. Educational demo only.",
        }

    def _tenant_caller(x_api_key: Optional[str]) -> tuple[Optional[str], bool]:
        """Resolve ``(owner_key_id, is_admin)`` for tenant-scoped routes.

        Mirrors ``_webhook_caller`` (defined later) so per-tenant routes
        (watchlist, picks) share one tenancy model. Returns:

        - user-managed key: that key's ``StoredKey.id`` and admin=True iff
          the role grants the ``admin`` scope,
        - env-registry admin key: ``(None, True)`` (operator/CI view),
        - operator-default ``SIGNALCLAW_API_KEY``: ``(None, True)``.

        ``require_api_key`` has already rejected unknown callers.
        """
        if not x_api_key:
            return None, False
        store_ = api_key_store
        if store_ is not None:
            stored = store_.lookup(x_api_key)
            if stored is not None:
                try:
                    from ..api_keys import cap_scopes_to_role
                    eff = set(cap_scopes_to_role(
                        stored.scopes, getattr(stored, "role", None)))
                except Exception:
                    eff = set(stored.scopes)
                return stored.id, ("admin" in eff)
        if x_api_key == settings.api_key:
            return None, True
        env_rec = get_registry().get(x_api_key)
        if env_rec is not None:
            return None, ("admin" in env_rec.scopes)
        return None, False

    @app.get("/watchlist", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def get_watchlist(x_api_key: str | None = Header(default=None)):
        owner_id, _ = _tenant_caller(x_api_key)
        return WatchlistOut(tickers=store.list_for(owner_id))

    @app.post("/watchlist", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def add_watchlist(body: WatchlistIn,
                      x_api_key: str | None = Header(default=None)):
        owner_id, _ = _tenant_caller(x_api_key)
        return WatchlistOut(tickers=store.add_for(owner_id, body.ticker))

    @app.delete("/watchlist/{ticker}", response_model=WatchlistOut, dependencies=[Depends(require_api_key)])
    def remove_watchlist(ticker: str,
                         x_api_key: str | None = Header(default=None)):
        owner_id, _ = _tenant_caller(x_api_key)
        return WatchlistOut(tickers=store.remove_for(owner_id, ticker))

    @app.get("/admin/watchlists",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_watchlists():
        """Admin aggregate view of every tenant's watchlist.

        Returns ``{tenants: {owner_key_id: [tickers...]}}``. The
        ``__default__`` key holds the legacy/operator bucket.
        """
        return {"tenants": store.all_tenants()}

    @app.get("/picks", response_model=DailyReportOut, dependencies=[Depends(require_api_key)])
    def picks(refresh: bool = False,
              x_api_key: str | None = Header(default=None)):
        owner_id, _ = _tenant_caller(x_api_key)
        rep = run_daily(store.list_for(owner_id), refresh=refresh)
        return DailyReportOut(as_of=rep.as_of, picks=[Pick(**p.to_dict()) for p in rep.picks])

    @app.get("/report.md", dependencies=[Depends(require_api_key)])
    def picks_markdown(refresh: bool = False,
                       x_api_key: str | None = Header(default=None)):
        owner_id, _ = _tenant_caller(x_api_key)
        rep = run_daily(store.list_for(owner_id), refresh=refresh)
        return {"markdown": render_markdown(rep)}

    @app.get("/backtest/{ticker}", response_model=BacktestOut, dependencies=[Depends(require_api_key)])
    def backtest(ticker: str, refresh: bool = False):
        t = ticker.upper().strip()
        if not t or len(t) > 12:
            raise HTTPException(400, "invalid ticker")
        df = load_ohlcv(t)
        if df.empty or refresh:
            df = fetch_ohlcv(t, period="3y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty:
            raise HTTPException(404, "no data")
        bt = WalkForwardBacktest().run(df)
        if bt.equity.empty:
            raise HTTPException(422, "insufficient history for walk-forward backtest")

        import math
        import numpy as _np

        equity = bt.equity
        dates = [d.strftime("%Y-%m-%d") for d in equity.index]
        equity_curve = [float(x) for x in equity.tolist()]

        # Buy and hold benchmark aligned to backtest window
        close = df["close"].reindex(equity.index).ffill()
        first = float(close.iloc[0]) if len(close) and close.iloc[0] else 1.0
        bh_curve = [float(v / first) if first else 1.0 for v in close.tolist()]

        # Strategy drawdown curve
        roll_max = equity.cummax()
        dd_curve = [float(v) for v in ((equity / roll_max) - 1.0).tolist()]

        # Position vector aligned to equity dates
        pos = bt.positions.reindex(equity.index).fillna(0.0)
        position = [float(x) for x in pos.tolist()]
        exposure = float(pos.gt(0).mean()) if len(pos) else 0.0

        # Reconstruct trades from position transitions (long-only 0/1)
        trades: list[dict] = []
        in_pos = False
        entry_idx: int | None = None
        entry_eq: float = 1.0
        for i, p in enumerate(position):
            on = p > 0.5
            if on and not in_pos:
                in_pos = True
                entry_idx = i
                entry_eq = equity_curve[i]
            elif not on and in_pos and entry_idx is not None:
                exit_eq = equity_curve[i]
                trades.append({
                    "entry_date": dates[entry_idx],
                    "exit_date": dates[i],
                    "bars": i - entry_idx,
                    "return_pct": float(exit_eq / entry_eq - 1.0) if entry_eq else 0.0,
                })
                in_pos = False
                entry_idx = None
        if in_pos and entry_idx is not None:
            trades.append({
                "entry_date": dates[entry_idx],
                "exit_date": dates[-1],
                "bars": len(dates) - 1 - entry_idx,
                "return_pct": float(equity_curve[-1] / entry_eq - 1.0) if entry_eq else 0.0,
            })

        # Benchmark metrics
        bh_series = _np.asarray(bh_curve, dtype=float)
        if len(bh_series) >= 2 and bh_series[0] > 0:
            years = max(len(bh_series) / 252.0, 1e-9)
            bench_cagr = float(bh_series[-1] ** (1.0 / years) - 1.0)
            bh_dd = float((bh_series / _np.maximum.accumulate(bh_series) - 1.0).min())
        else:
            bench_cagr = 0.0
            bh_dd = 0.0

        def _safe(x: float) -> float:
            return 0.0 if (x is None or math.isnan(x) or math.isinf(x)) else float(x)

        return BacktestOut(
            ticker=t,
            sharpe=_safe(bt.sharpe),
            sortino=_safe(bt.sortino),
            max_drawdown=_safe(bt.max_drawdown),
            hit_rate=_safe(bt.hit_rate),
            cagr=_safe(bt.cagr),
            n_trades=bt.n_trades,
            equity_curve=equity_curve,
            dates=dates,
            buy_hold_curve=bh_curve,
            drawdown_curve=dd_curve,
            position=position,
            trades=[BacktestTrade(**t_) for t_ in trades],
            benchmark_cagr=_safe(bench_cagr),
            benchmark_max_drawdown=_safe(bh_dd),
            exposure=_safe(exposure),
        )

    @app.get("/alerts", response_model=AlertListOut, dependencies=[Depends(require_api_key)])
    def alerts_list(ticker: str | None = None):
        rows = alert_store.list(ticker=ticker)
        return AlertListOut(alerts=[AlertOut(**a.to_dict()) for a in rows])

    @app.post("/alerts", response_model=AlertOut, dependencies=[Depends(require_api_key)])
    def alerts_add(body: AlertIn):
        try:
            cond = AlertCondition(body.condition)
        except ValueError:
            raise HTTPException(400, f"unknown condition {body.condition}")
        a = Alert(ticker=body.ticker.upper(), condition=cond, value=body.value,
                  note=body.note, cooldown_hours=body.cooldown_hours,
                  enabled=body.enabled)
        alert_store.add(a)
        return AlertOut(**a.to_dict())

    @app.delete("/alerts/{alert_id}", dependencies=[Depends(require_api_key)])
    def alerts_remove(alert_id: str):
        ok = alert_store.remove(alert_id)
        if not ok:
            raise HTTPException(404, "alert not found")
        return {"removed": alert_id}

    @app.post("/alerts/check", response_model=AlertCheckOut, dependencies=[Depends(require_api_key)])
    def alerts_check():
        rows = alert_store.list()
        ohlcv: dict = {}
        for t in {a.ticker for a in rows}:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            ohlcv[t] = df
        hits = evaluate_alerts(rows, ohlcv)
        if hits:
            alert_event_store.record(hits)
        for a in rows:
            alert_store.update(a)
        return AlertCheckOut(
            checked=len(rows),
            hits=[AlertHitOut(**h.to_dict()) for h in hits],
        )

    @app.get("/alerts/history", response_model=AlertHistoryOut,
             dependencies=[Depends(require_api_key)])
    def alerts_history(ticker: str | None = None,
                       limit: int = 100, offset: int = 0):
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        events = alert_event_store.list(ticker=ticker, limit=limit, offset=offset)
        return AlertHistoryOut(
            total=alert_event_store.count(ticker=ticker),
            limit=limit,
            offset=offset,
            events=[AlertEventOut(**e.to_dict()) for e in events],
        )

    @app.delete("/alerts/history/clear", dependencies=[Depends(require_api_key)])
    def alerts_history_clear():
        alert_event_store.clear()
        return {"cleared": True}

    @app.get("/portfolio/trades", response_model=TradeListOut, dependencies=[Depends(require_api_key)])
    def portfolio_trades_list():
        return TradeListOut(trades=[TradeOut(**t.to_dict()) for t in portfolio_store.trades()])

    @app.post("/portfolio/trades", response_model=TradeOut, dependencies=[Depends(require_api_key)])
    def portfolio_trade_add(body: TradeIn):
        try:
            side = TradeSide(body.side.lower())
        except ValueError:
            raise HTTPException(400, f"unknown side {body.side}")
        tr = Trade(ticker=body.ticker.upper(), side=side, quantity=body.quantity,
                   price=body.price, date=body.date, fees=body.fees, note=body.note)
        portfolio_store.add_trade(tr)
        return TradeOut(**tr.to_dict())

    @app.delete("/portfolio/trades/{trade_id}", dependencies=[Depends(require_api_key)])
    def portfolio_trade_remove(trade_id: str):
        ok = portfolio_store.remove_trade(trade_id)
        if not ok:
            raise HTTPException(404, "trade not found")
        return {"removed": trade_id}

    @app.get("/portfolio/snapshot", response_model=PortfolioSnapshotOut, dependencies=[Depends(require_api_key)])
    def portfolio_snapshot():
        positions = portfolio_store.positions()
        last_prices: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        return PortfolioSnapshotOut(**snap.to_dict())

    @app.post("/risk/size", response_model=SizingOut, dependencies=[Depends(require_api_key)])
    def risk_size(body: SizingRequest):
        df = load_ohlcv(body.ticker.upper())
        if df.empty:
            df = fetch_ohlcv(body.ticker.upper(), period="1y")
            if not df.empty:
                save_ohlcv(body.ticker.upper(), df)
        if df.empty:
            raise HTTPException(404, "no data for ticker")
        cfg = RiskConfig(
            equity=body.equity,
            risk_per_trade=body.risk_per_trade,
            max_position_pct=body.max_position_pct,
            kelly_fraction=body.kelly_fraction,
            kelly_cap=body.kelly_cap,
            atr_stop_mult=body.atr_stop_mult,
            atr_target_mult=body.atr_target_mult,
        )
        res = size_pick(body.ticker.upper(), df, body.label, body.score, cfg)
        return SizingOut(**res.to_dict())

    def _gather_closes(tickers):
        out = {}
        for t in tickers:
            t = t.upper()
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="1y")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                out[t] = df["close"]
        return out

    @app.get("/correlation", response_model=CorrelationMatrixOut, dependencies=[Depends(require_api_key)])
    def correlation_endpoint(window: int = 60, tickers: str | None = None):
        if tickers:
            tlist = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        else:
            tlist = store.list()
        closes = _gather_closes(tlist)
        m = correlation_matrix(closes, window=window)
        if m.empty:
            return CorrelationMatrixOut(tickers=list(closes.keys()), matrix=[], window=window)
        return CorrelationMatrixOut(
            tickers=list(m.index),
            matrix=[[float(x) for x in row] for row in m.values],
            window=window,
        )

    @app.get("/diversification", response_model=DiversificationOut, dependencies=[Depends(require_api_key)])
    def diversification_endpoint(window: int = 60, threshold: float = 0.70):
        tlist = store.list()
        closes = _gather_closes(tlist)
        # Use portfolio weights if a snapshot is available
        weights = None
        try:
            positions = portfolio_store.positions()
            last_prices = {}
            for t in positions:
                df = load_ohlcv(t)
                if not df.empty and "close" in df.columns:
                    last_prices[t] = float(df["close"].iloc[-1])
            snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
            if snap.weights:
                weights = snap.weights
        except Exception:
            weights = None
        rep = diversification_warnings(closes, weights=weights, window=window,
                                       cluster_threshold=threshold)
        d = rep.to_dict()
        return DiversificationOut(**d)

    @app.get("/news-events", response_model=NewsEventListOut,
             dependencies=[Depends(require_api_key)])
    def news_events_list_ep(ticker: str | None = None, tag: str | None = None,
                             date_from: str | None = None, date_to: str | None = None):
        rows = news_event_store.list(ticker=ticker, tag=tag,
                                        date_from=date_from, date_to=date_to)
        return NewsEventListOut(events=[NewsEventOut(**e.to_dict()) for e in rows])

    @app.post("/news-events", response_model=NewsEventOut,
              dependencies=[Depends(require_api_key)])
    def news_events_create_ep(body: NewsEventIn):
        try:
            ev = NewsEvent(
                ticker=body.ticker, headline=body.headline,
                event_date=body.event_date, tags=list(body.tags),
                source=body.source, url=body.url,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        news_event_store.add(ev)
        return NewsEventOut(**ev.to_dict())

    @app.delete("/news-events/{event_id}",
                dependencies=[Depends(require_api_key)])
    def news_events_remove_ep(event_id: str):
        if not news_event_store.remove(event_id):
            raise HTTPException(404, "event not found")
        return {"removed": event_id}

    @app.get("/news-events/study", response_model=EventStudyOut,
             dependencies=[Depends(require_api_key)])
    def news_events_study_ep(tag: str | None = None,
                              horizons: str = "1,5,20"):
        try:
            hz = tuple(int(x) for x in horizons.split(",") if x.strip())
        except ValueError:
            raise HTTPException(400, "horizons must be comma-separated integers")
        if not hz:
            raise HTTPException(400, "horizons required")
        events = news_event_store.list(tag=tag)
        tickers = sorted({e.ticker for e in events})
        closes = _gather_closes(tickers) if tickers else {}
        try:
            rep = event_study(events, closes, horizons=hz)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return EventStudyOut(**rep.to_dict())

    @app.post("/risk/pretrade", response_model=PretradeOut,
              dependencies=[Depends(require_api_key)])
    def pretrade_endpoint(body: PretradeIn):
        cm = body.cost or CostModelIn()
        try:
            req = OrderRequest(
                ticker=body.ticker, side=body.side,
                price=body.price, stop=body.stop, target=body.target,
                equity=body.equity,
                risk_per_trade=body.risk_per_trade,
                max_position_pct=body.max_position_pct,
                max_portfolio_pct=body.max_portfolio_pct,
                min_shares=body.min_shares,
                existing_shares=body.existing_shares,
                existing_avg_price=body.existing_avg_price,
                cost=CostModel(
                    commission_per_trade=cm.commission_per_trade,
                    commission_per_share=cm.commission_per_share,
                    slippage_bps=cm.slippage_bps,
                    min_commission=cm.min_commission,
                ),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        sim = simulate_order(req)
        return PretradeOut(**sim.to_dict())

    @app.post("/execution/simulate", response_model=ExecReportOut,
              dependencies=[Depends(require_api_key)])
    def execution_simulate_endpoint(body: ExecSimulateIn):
        try:
            schedule = ScheduleKind(body.order.schedule.lower())
        except ValueError:
            raise HTTPException(400, "schedule must be twap, vwap, or pov")
        try:
            order = ParentOrder(
                ticker=body.order.ticker, side=body.order.side,
                shares=body.order.shares,
                arrival_price=body.order.arrival_price,
                schedule=schedule,
                expected_curve=(tuple(body.order.expected_curve)
                                if body.order.expected_curve else None),
                participation_rate=body.order.participation_rate,
                max_participation=body.order.max_participation,
                base_slippage_bps=body.order.base_slippage_bps,
                slippage_bps_per_pct_adv=body.order.slippage_bps_per_pct_adv,
                commission_per_share=body.order.commission_per_share,
            )
            bars = [IntradayBar(index=b.index, price=b.price, volume=b.volume)
                    for b in body.bars]
            if not bars:
                raise ValueError("bars must be non-empty")
            rep = exec_simulate(order, bars)
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = rep.to_dict()
        return ExecReportOut(**d)

    @app.get("/ledger/{account}", response_model=LedgerListOut,
             dependencies=[Depends(require_api_key)])
    def ledger_list(account: str):
        es = ledger_store.entries(account)
        return LedgerListOut(
            account=account,
            entries=[LedgerEntryOut(**e.to_dict()) for e in es],
        )

    @app.post("/ledger/{account}", response_model=LedgerEntryOut,
              dependencies=[Depends(require_api_key)])
    def ledger_append(account: str, body: LedgerEntryIn):
        try:
            kind = EntryKind(body.kind.lower())
        except ValueError:
            raise HTTPException(400, f"invalid kind: {body.kind}")
        entry = LedgerEntry(
            ts=body.ts, kind=kind, amount=body.amount,
            ticker=body.ticker, shares=body.shares,
            price=body.price, note=body.note,
        )
        ledger_store.append(account, entry)
        return LedgerEntryOut(**entry.to_dict())

    @app.get("/ledger/{account}/snapshot", response_model=AccountSnapshotOut,
             dependencies=[Depends(require_api_key)])
    def ledger_snapshot_endpoint(account: str, marks: str | None = None):
        # marks is a comma-separated TICKER:PRICE list
        mark_map: dict[str, float] = {}
        if marks:
            for part in marks.split(","):
                part = part.strip()
                if not part or ":" not in part:
                    continue
                t, p = part.split(":", 1)
                try:
                    mark_map[t.strip().upper()] = float(p)
                except ValueError:
                    raise HTTPException(400, f"invalid mark: {part}")
        state = ledger_store.state(account)
        snap = ledger_snapshot(state, mark_map or None)
        return AccountSnapshotOut(account=account, **snap.to_dict())

    @app.put("/ledger/{account}/config", response_model=MarginConfigOut,
             dependencies=[Depends(require_api_key)])
    def ledger_set_config(account: str, body: MarginConfigIn):
        try:
            cfg = MarginConfig(
                initial_margin=body.initial_margin,
                maintenance_margin=body.maintenance_margin,
                annual_interest_rate=body.annual_interest_rate,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        ledger_store.set_config(account, cfg)
        return MarginConfigOut(
            initial_margin=cfg.initial_margin,
            maintenance_margin=cfg.maintenance_margin,
            annual_interest_rate=cfg.annual_interest_rate,
        )

    @app.get("/quality/anomalies/{ticker}", response_model=AnomalyReportOut,
             dependencies=[Depends(require_api_key)])
    def quality_anomalies(ticker: str,
                           z_threshold: float = 6.0,
                           atr_mult_threshold: float = 5.0,
                           iqr_mult_threshold: float = 4.0):
        df = load_ohlcv(ticker)
        if df is None or df.empty:
            raise HTTPException(404, f"no OHLCV cached for {ticker}")
        try:
            cfg = DetectorConfig(
                z_threshold=z_threshold,
                atr_mult_threshold=atr_mult_threshold,
                iqr_mult_threshold=iqr_mult_threshold,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        rep = detect_anomalies(df, cfg)
        return AnomalyReportOut(
            ticker=ticker.upper(),
            n_bars=rep.n_bars,
            n_anomalous=rep.n_anomalous,
            rate=rep.rate,
            anomalies=[AnomalyOut(**a.to_dict()) for a in rep.anomalies],
        )

    def _plan_to_out(p: ScalingPlan) -> ScalingPlanOut:
        return ScalingPlanOut(
            plan_id=p.plan_id, ticker=p.ticker,
            entry=p.entry, initial_stop=p.initial_stop,
            initial_shares=p.initial_shares,
            status=p.status.value, triggered=list(p.triggered),
            rungs=[ScaleRungIn(
                r_multiple=r.r_multiple, action=r.action.value,
                size_fraction=r.size_fraction, new_stop_r=r.new_stop_r,
            ) for r in p.rungs],
        )

    @app.get("/scaling/plans", response_model=ScalingPlanListOut,
             dependencies=[Depends(require_api_key)])
    def scaling_list():
        return ScalingPlanListOut(plans=[_plan_to_out(p)
                                          for p in scaling_store.list()])

    @app.post("/scaling/plans", response_model=ScalingPlanOut,
              dependencies=[Depends(require_api_key)])
    def scaling_create(body: ScalingPlanIn):
        try:
            rungs = [ScaleRung(
                r_multiple=r.r_multiple,
                action=ScaleAction(r.action.lower()),
                size_fraction=r.size_fraction,
                new_stop_r=r.new_stop_r,
            ) for r in body.rungs]
            plan = ScalingPlan(
                ticker=body.ticker, entry=body.entry,
                initial_stop=body.initial_stop,
                initial_shares=body.initial_shares,
                rungs=rungs,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        scaling_store.upsert(plan)
        return _plan_to_out(plan)

    @app.delete("/scaling/plans/{plan_id}",
                dependencies=[Depends(require_api_key)])
    def scaling_delete(plan_id: str):
        if not scaling_store.delete(plan_id):
            raise HTTPException(404, "plan not found")
        return {"ok": True}

    @app.post("/scaling/plans/{plan_id}/cancel", response_model=ScalingPlanOut,
              dependencies=[Depends(require_api_key)])
    def scaling_cancel(plan_id: str):
        if not scaling_store.cancel(plan_id):
            raise HTTPException(404, "plan not found")
        return _plan_to_out(scaling_store.get(plan_id))

    @app.post("/scaling/plans/{plan_id}/evaluate",
              response_model=ScaleEvaluateOut,
              dependencies=[Depends(require_api_key)])
    def scaling_evaluate(plan_id: str, body: ScaleEvaluateIn):
        plan = scaling_store.get(plan_id)
        if plan is None:
            raise HTTPException(404, "plan not found")
        try:
            bars = [PriceBar(index=b.index, high=b.high, low=b.low)
                    for b in body.bars]
        except ValueError as e:
            raise HTTPException(400, str(e))
        events, new_plan = evaluate_plan(plan, bars)
        scaling_store.upsert(new_plan)
        return ScaleEvaluateOut(
            plan=_plan_to_out(new_plan),
            events=[ScaleEventOut(**e.to_dict()) for e in events],
        )

    @app.get("/rotation", response_model=RotationOut,
             dependencies=[Depends(require_api_key)])
    def rotation_endpoint(benchmark: str = "SPY",
                          lookback_short: int = 21,
                          lookback_mid: int = 63,
                          lookback_long: int = 126,
                          tickers: str | None = None):
        if tickers:
            tlist = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        else:
            tlist = store.list()
        if benchmark not in tlist:
            tlist = list(tlist) + [benchmark]
        closes = _gather_closes(tlist)
        if benchmark not in closes:
            raise HTTPException(404, f"benchmark {benchmark} unavailable")
        try:
            rep = sector_rotation(
                closes, benchmark=benchmark,
                lookbacks=(lookback_short, lookback_mid, lookback_long),
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = rep.to_dict()
        return RotationOut(**d)

    @app.get("/portfolio/attribution", response_model=AttributionOut, dependencies=[Depends(require_api_key)])
    def portfolio_attribution(window: int = 60, benchmark: str = "SPY"):
        positions = portfolio_store.positions()
        if not positions:
            raise HTTPException(404, "no positions")
        last_prices: dict = {}
        closes: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
                closes[t] = df["close"]
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        if not snap.weights:
            raise HTTPException(422, "weights unavailable (need last prices)")
        bdf = load_ohlcv(benchmark)
        if bdf.empty:
            bdf = fetch_ohlcv(benchmark, period="2y")
            if not bdf.empty:
                save_ohlcv(benchmark, bdf)
        if bdf.empty or "close" not in bdf.columns:
            raise HTTPException(404, f"no benchmark data for {benchmark}")
        rep = attribution(snap.weights, closes, bdf["close"], window=window)
        if rep is None:
            raise HTTPException(422, "insufficient overlapping history")
        d = rep.to_dict()
        d["benchmark"] = benchmark.upper()
        return AttributionOut(**d)

    @app.get("/portfolio/sectors", response_model=ConcentrationOut, dependencies=[Depends(require_api_key)])
    def portfolio_sectors(sector_cap: float = 0.35, position_cap: float = 0.25):
        positions = portfolio_store.positions()
        if not positions:
            raise HTTPException(404, "no positions")
        last_prices: dict = {}
        for t in positions:
            df = load_ohlcv(t)
            if df.empty:
                df = fetch_ohlcv(t, period="3mo")
                if not df.empty:
                    save_ohlcv(t, df)
            if not df.empty and "close" in df.columns:
                last_prices[t] = float(df["close"].iloc[-1])
        snap = compute_snapshot(positions, last_prices, trades=portfolio_store.trades())
        if not snap.weights:
            raise HTTPException(422, "weights unavailable (need last prices)")
        mv = {p.ticker: p.market_value for p in snap.positions}
        rep = sector_exposure(
            snap.weights, market_values=mv,
            sector_cap=sector_cap, position_cap=position_cap,
        )
        return ConcentrationOut(**rep.to_dict())

    @app.get("/portfolio/tax", response_model=TaxReportOut, dependencies=[Depends(require_api_key)])
    def portfolio_tax(method: str = "fifo", wash_window: int = 30):
        try:
            m = LotMethod(method.lower())
        except ValueError:
            raise HTTPException(400, f"unknown method {method}")
        trades = portfolio_store.trades()
        rep = tax_summary(trades, method=m, wash_window=wash_window)
        return TaxReportOut(**rep.to_dict())

    @app.get("/optimize/{ticker}", response_model=OptResultOut, dependencies=[Depends(require_api_key)])
    def optimize(ticker: str, train: int = 252, test: int = 63,
                 refresh: bool = False):
        t = ticker.upper()
        df = load_ohlcv(t)
        if df.empty or refresh:
            df = fetch_ohlcv(t, period="5y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        try:
            res = walk_forward_optimize(df["close"], train_window=train,
                                        test_window=test)
        except ValueError as e:
            raise HTTPException(400, str(e))
        d = res.to_dict()
        # tuples come back as lists when serialized
        d["ticker"] = t
        return OptResultOut(**d)

    @app.get("/regime", dependencies=[Depends(require_api_key)])
    def regime_endpoint(ticker: str = "SPY"):
        df = load_ohlcv(ticker)
        if df.empty:
            df = fetch_ohlcv(ticker, period="3y")
            if not df.empty:
                save_ohlcv(ticker, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        snap = detect_regime(df["close"])
        if snap is None:
            raise HTTPException(422, "insufficient history")
        return snap.to_dict()

    @app.get("/regime/series", dependencies=[Depends(require_api_key)])
    def regime_series_endpoint(ticker: str = "SPY", lookback_days: int = 504):
        """Per-bar regime classification for charting.

        Returns aligned arrays of dates, close prices, and regime labels for the
        most recent `lookback_days` trading days, plus the current snapshot and
        a summary of bars per regime.
        """
        t = ticker.upper().strip()
        if not t or len(t) > 12:
            raise HTTPException(400, "invalid ticker")
        try:
            lookback_days = max(60, min(int(lookback_days), 2520))
        except (TypeError, ValueError):
            raise HTTPException(400, "lookback_days must be an integer")
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period="5y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty or "close" not in df.columns:
            raise HTTPException(404, "no data")
        close = df["close"].dropna()
        if len(close) < 260:
            raise HTTPException(422, "insufficient history")
        labels = regime_series(close)
        tail = close.tail(lookback_days)
        tail_labels = labels.reindex(tail.index)
        dates = [str(d.date() if hasattr(d, "date") else d) for d in tail.index]
        closes = [float(v) for v in tail.values]
        regs = [str(v) if v == v and v is not None else None for v in tail_labels.values]
        counts: dict[str, int] = {}
        for r in regs:
            if r:
                counts[r] = counts.get(r, 0) + 1
        snap = detect_regime(close)
        return {
            "ticker": t,
            "dates": dates,
            "close": closes,
            "regime": regs,
            "counts": counts,
            "snapshot": snap.to_dict() if snap else None,
        }

    @app.get("/explain/{ticker}", response_model=ExplainOut, dependencies=[Depends(require_api_key)])
    def explain_endpoint(ticker: str, lookback_days: int = 180):
        """Per-ticker explanation: runs the same per-ticker pipeline used by
        daily picks (features + ensemble) and returns the prediction with
        per-feature contributions, rationale text, risk flags, and a price
        history window for charting. No persisted state is mutated.
        """
        t = ticker.upper().strip()
        if not t or len(t) > 12 or not all(c.isalnum() or c in "-." for c in t):
            raise HTTPException(400, "invalid ticker")
        try:
            lookback_days = max(30, min(int(lookback_days), 1260))
        except (TypeError, ValueError):
            raise HTTPException(400, "lookback_days must be an integer")
        df = load_ohlcv(t)
        if df.empty:
            df = fetch_ohlcv(t, period="3y")
            if not df.empty:
                save_ohlcv(t, df)
        if df.empty or "close" not in df.columns or len(df) < 300:
            raise HTTPException(404, "insufficient history for ticker")

        import pandas as _pd
        # Sentiment is intentionally omitted in /explain to keep latency low and
        # avoid pulling a transformer model on the first call; the feature
        # column is filled with 0.0 by build_features when sentiment is empty.
        sentiment = _pd.Series(dtype=float)

        feats = build_features(df, sentiment=sentiment)
        labels = make_labels(df["close"], horizon=5)
        joined = feats.join(labels, how="inner").dropna()
        if len(joined) < 200:
            raise HTTPException(422, "insufficient feature history")
        feat_cols = [c for c in joined.columns if c not in ("label", "fwd_ret")]
        train = joined.iloc[:-1]
        clf = WatchHoldSkipClassifier().fit(train[feat_cols], train["label"])
        reg = ReturnRegressor().fit(train[feat_cols], train["fwd_ret"])
        ens = Ensemble(clf, reg)
        last_row_df = joined.iloc[[-1]][feat_cols]
        pred = ens.predict_row(last_row_df)
        row = joined.iloc[-1]
        rationale = rationale_for(t, row, pred)
        flags = compute_risk_flags(row)

        # Per-feature contributions: signed bullish/bearish reading per known feature.
        feature_meta = {
            "rsi14": ("RSI (14)", lambda v: ("bearish" if v > 65 else ("bullish" if v < 35 else "neutral")),
                       lambda v: min(1.0, abs(v - 50) / 30.0),
                       lambda v: f"{v:.0f} (oversold<35, overbought>65)"),
            "macd_hist": ("MACD histogram", lambda v: "bullish" if v > 0 else ("bearish" if v < 0 else "neutral"),
                          lambda v: min(1.0, abs(v) * 5.0),
                          lambda v: f"{v:+.3f}"),
            "bb_pct": ("Bollinger %B", lambda v: ("bearish" if v > 0.9 else ("bullish" if v < 0.1 else "neutral")),
                       lambda v: min(1.0, abs(v - 0.5) * 2.0),
                       lambda v: f"{v:.2f} (0=lower band, 1=upper band)"),
            "sma_20_50_ratio": ("SMA20 / SMA50", lambda v: "bullish" if v > 1.0 else "bearish",
                                lambda v: min(1.0, abs(v - 1.0) * 20.0),
                                lambda v: f"{v:.3f}"),
            "ema_12_26_ratio": ("EMA12 / EMA26", lambda v: "bullish" if v > 1.0 else "bearish",
                                lambda v: min(1.0, abs(v - 1.0) * 20.0),
                                lambda v: f"{v:.3f}"),
            "ret_5": ("5-day return", lambda v: "bullish" if v > 0 else "bearish",
                      lambda v: min(1.0, abs(v) * 10.0),
                      lambda v: f"{v*100:+.2f}%"),
            "ret_20": ("20-day return", lambda v: "bullish" if v > 0 else "bearish",
                       lambda v: min(1.0, abs(v) * 5.0),
                       lambda v: f"{v*100:+.2f}%"),
            "vol_20": ("Realized vol (20d, ann.)", lambda v: "bearish" if v > 0.5 else ("bullish" if v < 0.2 else "neutral"),
                       lambda v: min(1.0, abs(v - 0.3) * 3.0),
                       lambda v: f"{v*100:.0f}%"),
            "obv_z": ("OBV z-score", lambda v: "bullish" if v > 0 else "bearish",
                      lambda v: min(1.0, abs(v) / 2.0),
                      lambda v: f"{v:+.2f}"),
            "sentiment_5d": ("News sentiment (5d)", lambda v: "bullish" if v > 0.1 else ("bearish" if v < -0.1 else "neutral"),
                             lambda v: min(1.0, abs(v) * 2.0),
                             lambda v: f"{v:+.2f}"),
            "vol_regime": ("Vol regime", lambda v: "bearish" if v == 1 else ("bullish" if v == -1 else "neutral"),
                           lambda v: 0.6 if v != 0 else 0.0,
                           lambda v: {1: "high", -1: "low", 0: "normal"}.get(int(v), str(v))),
        }
        contribs: list[FeatureContribOut] = []
        for name, (label, dir_fn, weight_fn, note_fn) in feature_meta.items():
            if name not in row.index:
                continue
            try:
                v = float(row[name])
            except Exception:
                continue
            if v != v:  # NaN
                continue
            contribs.append(FeatureContribOut(
                name=name, label=label, value=v,
                direction=dir_fn(v), weight=float(weight_fn(v)), note=note_fn(v),
            ))
        contribs.sort(key=lambda c: c.weight, reverse=True)

        tail = df["close"].dropna().tail(lookback_days)
        dates = [str(d.date() if hasattr(d, "date") else d) for d in tail.index]
        closes = [float(v) for v in tail.values]
        as_of = dates[-1] if dates else ""

        return ExplainOut(
            ticker=t, as_of=as_of,
            label=pred.label, score=float(pred.score),
            expected_return=float(pred.expected_return),
            proba={k: float(v) for k, v in pred.proba.items()},
            rationale=rationale, risk_flags=flags,
            features=contribs, dates=dates, close=closes,
            history_label=pred.label,
        )

    @app.get("/earnings", response_model=EarningsListOut, dependencies=[Depends(require_api_key)])
    def earnings_list(within_days: int | None = None):
        if within_days is not None:
            rows = earnings_store.upcoming(within_days=int(within_days))
        else:
            rows = earnings_store.list()
        return EarningsListOut(rows=[EarningsOut(**e.to_dict()) for e in rows])

    @app.put("/earnings/{ticker}", response_model=EarningsOut, dependencies=[Depends(require_api_key)])
    def earnings_upsert(ticker: str, body: EarningsIn):
        try:
            from datetime import datetime as _dt
            _dt.fromisoformat(body.next_report)
        except Exception:
            raise HTTPException(400, "next_report must be ISO date YYYY-MM-DD")
        e = EarningsDate(ticker=ticker.upper(), next_report=body.next_report,
                         confirmed=body.confirmed, source=body.source)
        earnings_store.set(e)
        return EarningsOut(**e.to_dict())

    @app.delete("/earnings/{ticker}", dependencies=[Depends(require_api_key)])
    def earnings_remove(ticker: str):
        if not earnings_store.remove(ticker):
            raise HTTPException(404, "not found")
        return {"ok": True}

    @app.get("/stops", response_model=StopRuleListOut, dependencies=[Depends(require_api_key)])
    def stops_list():
        return StopRuleListOut(rules=[StopRuleOut(**r.to_dict()) for r in stops_store.list()])

    @app.post("/stops", response_model=StopRuleOut, dependencies=[Depends(require_api_key)])
    def stops_add(body: StopRuleIn):
        try:
            kind = StopKind(body.kind)
        except ValueError:
            raise HTTPException(400, f"invalid kind: {body.kind}")
        if kind == StopKind.TRAILING and not (0 < body.value < 1):
            raise HTTPException(400, "trailing value must be a fraction in (0, 1)")
        if kind in (StopKind.STOP_LOSS, StopKind.TAKE_PROFIT) and body.value <= 0:
            raise HTTPException(400, "price level must be positive")
        rule = StopRule(ticker=body.ticker.upper(), kind=kind,
                        value=float(body.value), note=body.note)
        stops_store.add(rule)
        return StopRuleOut(**rule.to_dict())

    @app.delete("/stops/{rule_id}", dependencies=[Depends(require_api_key)])
    def stops_remove(rule_id: str):
        ok = stops_store.remove(rule_id)
        if not ok:
            raise HTTPException(404, "rule not found")
        return {"ok": True}

    @app.post("/stops/check", response_model=StopCheckOut, dependencies=[Depends(require_api_key)])
    def stops_check():
        rules = stops_store.list()
        prices: dict = {}
        for r in rules:
            df = load_ohlcv(r.ticker)
            if not df.empty and "close" in df.columns:
                prices[r.ticker] = float(df["close"].iloc[-1])
        events = evaluate_rules(rules, prices)
        for r in rules:
            if r.kind == StopKind.TRAILING:
                stops_store.update(r)
        return StopCheckOut(
            checked=len(rules),
            events=[StopEventOut(**e.to_dict()) for e in events],
        )

    @app.get("/reports/history", response_model=ReportHistoryOut, dependencies=[Depends(require_api_key)])
    def reports_history(limit: int = 30):
        rows = archive.summaries(limit=limit)
        return ReportHistoryOut(summaries=[ReportSummaryOut(**r.to_dict()) for r in rows])

    @app.get("/reports/diff/latest", response_model=ReportDiffOut, dependencies=[Depends(require_api_key)])
    def reports_diff_latest():
        d = archive.diff_latest()
        if d is None:
            raise HTTPException(404, "no reports archived")
        return ReportDiffOut(**d.to_dict())

    @app.get("/reports/diff/{as_of}", response_model=ReportDiffOut, dependencies=[Depends(require_api_key)])
    def reports_diff_for(as_of: str, vs: str | None = None):
        d = archive.diff_between(as_of, vs)
        if d is None:
            raise HTTPException(404, "report not found")
        return ReportDiffOut(**d.to_dict())

    @app.post("/reports/archive", response_model=ReportSummaryOut, dependencies=[Depends(require_api_key)])
    def reports_archive_now():
        rep = run_daily(store.list(), refresh=False)
        archive.save(rep)
        from ..history.archive import _summary
        return ReportSummaryOut(**_summary(rep).to_dict())

    @app.get("/reports/{as_of}", response_model=DailyReportOut, dependencies=[Depends(require_api_key)])
    def reports_get(as_of: str):
        r = archive.load(as_of)
        if r is None:
            raise HTTPException(404, "report not found")
        return DailyReportOut(as_of=r.as_of,
                              picks=[Pick(**p.to_dict()) for p in r.picks])

    class _ScopedWebhookStore:
        """Adapter that exposes only a caller-visible slice of webhooks.

        ``deliver_events`` iterates ``store.list()`` and calls
        ``store.update(sub)`` per matched subscription. This wrapper
        narrows ``list()`` to the caller's own subscriptions while
        still letting the deliverer persist last-status updates against
        the underlying store.
        """
        def __init__(self, real, visible):
            self._real = real
            self._visible = list(visible)

        def list(self):
            return list(self._visible)

        def update(self, sub):
            return self._real.update(sub)

    def _webhook_caller(x_api_key: Optional[str]) -> tuple[Optional[str], bool]:
        """Resolve (owner_key_id, is_admin) for the webhooks tenant gate.

        - User-managed key: returns its ``StoredKey.id`` and admin=True
          iff the role grants the ``admin`` scope.
        - Env-registry key (``SIGNALCLAW_API_KEYS_JSON``) with the
          ``admin`` scope: returns ``(None, True)`` so an operator can
          run a CI/admin key that sees every tenant's webhooks.
        - Operator-default env key (``SIGNALCLAW_API_KEY``): returns
          ``(None, True)``. Matches the legacy single-key deployment
          where there is exactly one tenant.
        - Unknown / unauth: ``(None, False)``. The route's
          ``require_api_key`` dependency rejects this before we get
          here, but the fall-through is fail-closed regardless.
        """
        if not x_api_key:
            return None, False
        store = api_key_store
        if store is not None:
            stored = store.lookup(x_api_key)
            if stored is not None:
                try:
                    from ..api_keys import cap_scopes_to_role  # local
                    eff = set(cap_scopes_to_role(
                        stored.scopes, getattr(stored, "role", None)))
                except Exception:
                    eff = set(stored.scopes)
                return stored.id, ("admin" in eff)
        if x_api_key == settings.api_key:
            return None, True
        env_rec = get_registry().get(x_api_key)
        if env_rec is not None:
            return None, ("admin" in env_rec.scopes)
        return None, False

    def _webhook_outcome(sub, transition: str, info: dict) -> None:
        """Audit-log circuit-breaker transitions for a webhook delivery."""
        from ..audit.log import AuditEvent as _AE_wh, _utc_now_iso as _iso_wh
        from ..webhooks import AUTO_DISABLE_FAILURE_THRESHOLD as _THR
        action = ("webhook.auto_disabled" if transition == "auto_disabled"
                  else "webhook.recovered")
        extra = {
            "subscription_id": sub.id,
            "url": sub.url,
            "owner_key_id": sub.owner_key_id,
            "consecutive_failures": int(sub.consecutive_failures or 0),
            "reason": sub.auto_disable_reason,
            "last_status": info.get("status"),
            "last_error": (info.get("error") or "")[:200] or None,
            "threshold": _THR,
        }
        try:
            audit_log.record(_AE_wh(
                ts=_iso_wh(), request_id="-",
                method="-", path="/webhooks/_circuit",
                status=200 if transition == "recovered" else 503,
                actor_key_hash="-", actor_label="webhook_circuit",
                source_ip="-", duration_ms=0.0,
                action=action, extra=extra,
            ))
        except Exception:
            pass

    @app.get("/webhooks", response_model=WebhookListOut, dependencies=[Depends(require_api_key)])
    def webhooks_list(x_api_key: str | None = Header(default=None)):
        owner_id, is_admin = _webhook_caller(x_api_key)
        return WebhookListOut(subscriptions=[
            WebhookOut(**s.to_dict())
            for s in webhooks_store.list_for(owner_id, is_admin=is_admin)])

    @app.post("/webhooks", response_model=WebhookOut, dependencies=[Depends(require_api_key)])
    def webhooks_add(body: WebhookIn,
                     x_api_key: str | None = Header(default=None)):
        from ..webhooks.destination import validate_destination
        ok, reason = validate_destination(body.url)
        if not ok:
            raise HTTPException(400, reason)
        bad = [e for e in body.events if e and e not in EVENT_KINDS]
        if bad:
            raise HTTPException(400, f"unknown event(s): {bad}")
        owner_id, _ = _webhook_caller(x_api_key)
        tok, treason = webhook_host_allowlist.check(owner_id, body.url)
        if not tok:
            raise HTTPException(400, treason)
        sub = WebhookSubscription(
            url=body.url,
            events=list(body.events) if body.events else sorted(EVENT_KINDS),
            tickers=[t.upper() for t in body.tickers],
            secret=body.secret,
            enabled=body.enabled,
            owner_key_id=owner_id,
        )
        webhooks_store.add(sub)
        return WebhookOut(**sub.to_dict())

    @app.delete("/webhooks/{sub_id}", dependencies=[Depends(require_api_key)])
    def webhooks_remove(sub_id: str,
                        x_api_key: str | None = Header(default=None)):
        sub = webhooks_store.get(sub_id)
        if sub is None:
            raise HTTPException(404, "subscription not found")
        owner_id, is_admin = _webhook_caller(x_api_key)
        if not sub.is_visible_to(owner_id, is_admin=is_admin):
            # Do not reveal existence to non-owners.
            raise HTTPException(404, "subscription not found")
        if not webhooks_store.remove(sub_id):
            raise HTTPException(404, "subscription not found")
        return {"removed": sub_id}

    @app.patch("/webhooks/{sub_id}",
               response_model=WebhookOut,
               dependencies=[Depends(require_api_key)])
    async def webhooks_update(sub_id: str,
                              request: Request,
                              x_api_key: str | None = Header(default=None)):
        """Patch a subscription's url, events, tickers, or enabled flag.

        Tenant-scoped: a non-owner sees 404 (not 403) so cross-tenant
        existence does not leak; an admin-scope key can edit any
        subscription. ``url`` is re-validated against the SSRF
        destination policy so a tenant cannot pivot an existing
        subscription onto a private address. Every accepted change is
        appended to the hash-chained audit log with the field-level
        diff so reviewers can reconstruct who changed what.
        Secret rotation is intentionally not handled here: use
        ``POST /webhooks/{id}/rotate-secret`` so the grace-window path
        runs.
        """
        from ..webhooks.destination import validate_destination
        try:
            raw = await request.json()
        except Exception:
            raise HTTPException(400, "body must be JSON")
        if not isinstance(raw, dict):
            raise HTTPException(400, "body must be a JSON object")
        try:
            body = WebhookUpdateIn(**raw)
        except Exception as e:
            raise HTTPException(422, str(e))
        sub = webhooks_store.get(sub_id)
        owner_id, is_admin = _webhook_caller(x_api_key)
        if sub is None or not sub.is_visible_to(owner_id, is_admin=is_admin):
            raise HTTPException(404, "subscription not found")

        changes: Dict[str, Any] = {}
        if body.url is not None and body.url != sub.url:
            ok, reason = validate_destination(body.url)
            if not ok:
                raise HTTPException(400, reason)
            tok, treason = webhook_host_allowlist.check(
                sub.owner_key_id, body.url)
            if not tok:
                raise HTTPException(400, treason)
            changes["url"] = {"from": sub.url, "to": body.url}
            sub.url = body.url
        if body.events is not None:
            new_events = sorted({e for e in body.events if e})
            bad = [e for e in new_events if e not in EVENT_KINDS]
            if bad:
                raise HTTPException(400, f"unknown event(s): {bad}")
            if not new_events:
                raise HTTPException(422, "events must not be empty")
            if new_events != sorted(sub.events):
                changes["events"] = {"from": sorted(sub.events), "to": new_events}
                sub.events = new_events
        if body.tickers is not None:
            new_tickers = sorted({t.upper() for t in body.tickers if t})
            if new_tickers != sorted(sub.tickers):
                changes["tickers"] = {"from": sorted(sub.tickers), "to": new_tickers}
                sub.tickers = new_tickers
        if body.enabled is not None and body.enabled != sub.enabled:
            changes["enabled"] = {"from": sub.enabled, "to": body.enabled}
            sub.enabled = body.enabled
            # A manual re-enable clears the circuit breaker too so the
            # next fan-out actually attempts delivery instead of being
            # immediately re-disabled by a stale auto-disable marker.
            if body.enabled and sub.auto_disabled_at is not None:
                changes["auto_disabled_cleared"] = True
                sub.auto_disabled_at = None
                sub.auto_disable_reason = None
                sub.consecutive_failures = 0

        if not changes:
            return WebhookOut(**sub.to_dict())

        webhooks_store.update(sub)
        try:
            from ..audit.log import AuditEvent as _AE_wu, _utc_now_iso as _iso_wu, _hash_key as _hk_wu
            src_ip = (request.client.host if request.client else "-") or "-"
            audit_log.record(_AE_wu(
                ts=_iso_wu(),
                request_id=request.headers.get("x-request-id", "-"),
                method="PATCH", path=f"/webhooks/{sub_id}",
                status=200,
                actor_key_hash=_hk_wu(x_api_key or ""),
                actor_label="admin" if is_admin else "owner",
                source_ip=src_ip, duration_ms=0.0,
                action="webhook.updated",
                extra={"subscription_id": sub.id,
                       "owner_key_id": sub.owner_key_id,
                       "changes": changes},
            ))
        except Exception:
            pass
        return WebhookOut(**sub.to_dict())

    # --- Per-tenant outbound webhook host allowlist --------------------
    # Enterprise tenants gate which external hosts their webhooks may
    # fire to. Composes additively with the global SSRF gate in
    # ``webhooks/destination.py``: a destination must pass both. The
    # admin console surface is /settings/webhook-allowlist.
    @app.get("/webhooks/host-allowlist",
             dependencies=[Depends(require_api_key)])
    def webhooks_host_allowlist_get(
        x_api_key: str | None = Header(default=None),
    ):
        owner_id, _ = _webhook_caller(x_api_key)
        p = webhook_host_allowlist.get(owner_id)
        return p.to_public()

    @app.put("/webhooks/host-allowlist",
             dependencies=[Depends(require_api_key)])
    def webhooks_host_allowlist_put(
        body: dict,
        request: Request,
        x_api_key: str | None = Header(default=None),
    ):
        """Replace the calling tenant's outbound webhook host allowlist.

        Body shape: ``{"enabled": bool, "hosts": ["hooks.slack.com", ...]}``.
        Refuses ``enabled=true`` with no hosts to prevent the tenant
        accidentally disabling every webhook they have. Mutations are
        audited with the field-level diff.
        """
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        enabled = bool(body.get("enabled", False))
        raw_hosts = body.get("hosts") or []
        if not isinstance(raw_hosts, list):
            raise HTTPException(400, "hosts must be a list of strings")
        from ..webhooks.host_allowlist import normalise_host
        try:
            for h in raw_hosts:
                if not isinstance(h, str):
                    raise ValueError("hosts entries must be strings")
                normalise_host(h)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        owner_id, is_admin = _webhook_caller(x_api_key)
        prev = webhook_host_allowlist.get(owner_id)
        actor = (x_api_key or "")[:12] or ("admin" if is_admin else "owner")
        try:
            new = webhook_host_allowlist.set(
                owner_id, enabled=enabled, hosts=raw_hosts, actor=actor)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        # Audit the change with a field-level diff. Same shape as the
        # webhook PATCH audit so SIEM rules can match on the same
        # action prefix.
        try:
            from ..audit.log import (
                AuditEvent as _AE_ha,
                _utc_now_iso as _iso_ha,
                _hash_key as _hk_ha,
            )
            changes: Dict[str, Any] = {}
            if prev.enabled != new.enabled:
                changes["enabled"] = {
                    "from": prev.enabled, "to": new.enabled}
            added = sorted(set(new.hosts) - set(prev.hosts))
            removed = sorted(set(prev.hosts) - set(new.hosts))
            if added:
                changes["hosts_added"] = added
            if removed:
                changes["hosts_removed"] = removed
            src_ip = (request.client.host if request.client else "-") or "-"
            audit_log.record(_AE_ha(
                ts=_iso_ha(),
                request_id=request.headers.get("x-request-id", "-"),
                method="PUT", path="/webhooks/host-allowlist",
                status=200,
                actor_key_hash=_hk_ha(x_api_key or ""),
                actor_label="admin" if is_admin else "owner",
                source_ip=src_ip, duration_ms=0.0,
                action="webhook.host_allowlist.updated",
                extra={
                    "owner_key_id": owner_id,
                    "enabled": new.enabled,
                    "host_count": len(new.hosts),
                    "changes": changes,
                },
            ))
        except Exception:
            pass
        return new.to_public()

    @app.post("/webhooks/{sub_id}/rotate-secret",
              response_model=WebhookRotateSecretOut,
              dependencies=[Depends(require_api_key)])
    def webhooks_rotate_secret(sub_id: str, body: WebhookRotateSecretIn,
                               x_api_key: str | None = Header(default=None)):
        """Rotate the HMAC signing secret with a grace window.

        The prior secret is retained for ``grace_seconds`` so receivers
        can verify with either secret while they roll their verifier.
        During grace, deliveries emit ``X-SignalClaw-Signature`` (new
        secret) AND ``X-SignalClaw-Signature-Previous`` (prior secret).
        After grace, only the new secret signs. ``secret=""`` mints a
        cryptographically random 32-byte hex secret.
        """
        import secrets as _secrets
        sub = webhooks_store.get(sub_id)
        if sub is None:
            raise HTTPException(404, "subscription not found")
        owner_id, is_admin = _webhook_caller(x_api_key)
        if not sub.is_visible_to(owner_id, is_admin=is_admin):
            # Tenant isolation: do not reveal existence to non-owners.
            raise HTTPException(404, "subscription not found")
        new_secret = body.secret.strip() or _secrets.token_hex(32)
        if len(new_secret) < 16:
            raise HTTPException(422, "secret must be at least 16 chars")
        now_struct = time.gmtime()
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", now_struct)
        prior = sub.secret or ""
        if prior and body.grace_seconds > 0:
            exp_iso = time.strftime(
                "%Y-%m-%dT%H:%M:%SZ",
                time.gmtime(time.time() + int(body.grace_seconds)))
            sub.previous_secret = prior
            sub.previous_secret_expires_at = exp_iso
        else:
            sub.previous_secret = ""
            sub.previous_secret_expires_at = None
        sub.secret = new_secret
        sub.secret_rotated_at = now_iso
        webhooks_store.update(sub)
        return WebhookRotateSecretOut(
            id=sub.id,
            secret_rotated_at=sub.secret_rotated_at,
            previous_secret_expires_at=sub.previous_secret_expires_at,
            grace_seconds=int(body.grace_seconds) if prior else 0,
        )

    @app.post("/webhooks/fire/latest", response_model=WebhookDeliveryOut,
              dependencies=[Depends(require_api_key)])
    def webhooks_fire_latest(x_api_key: str | None = Header(default=None)):
        latest = archive.latest()
        if latest is None:
            raise HTTPException(404, "no archived reports")
        prior = archive.prior_of(latest.as_of)
        events = diff_picks(
            current=[p.to_dict() for p in latest.picks],
            prior=[p.to_dict() for p in prior.picks] if prior else None,
            current_as_of=latest.as_of,
            prior_as_of=prior.as_of if prior else None,
        )
        # Tenant-scope fan-out: deliver only to subscriptions the caller
        # owns. Admins fan out to every visible subscription, matching
        # the legacy behaviour for the operator-default key.
        owner_id, is_admin = _webhook_caller(x_api_key)
        visible_subs = webhooks_store.list_for(owner_id, is_admin=is_admin)
        scoped_store = _ScopedWebhookStore(webhooks_store, visible_subs)
        deliveries = deliver_events(events, scoped_store,
                                    log_store=webhook_log_store,
                                    on_outcome=_webhook_outcome)
        return WebhookDeliveryOut(
            events=[PickEventOut(**e.to_dict()) for e in events],
            deliveries=deliveries,
        )

    @app.get("/webhooks/deliveries", response_model=WebhookDeliveryLogOut,
             dependencies=[Depends(require_api_key)])
    def webhooks_deliveries(limit: int = 50,
                            status: Optional[str] = None,
                            subscription_id: Optional[str] = None,
                            x_api_key: str | None = Header(default=None)):
        if status is not None and status not in ("ok", "failed"):
            raise HTTPException(400, "status must be 'ok' or 'failed'")
        owner_id, is_admin = _webhook_caller(x_api_key)
        visible_ids = {s.id for s in
                       webhooks_store.list_for(owner_id, is_admin=is_admin)}
        if subscription_id is not None and subscription_id not in visible_ids \
                and not is_admin:
            # Non-admins asking for someone else's sub get an empty list,
            # not a 404, to avoid leaking existence.
            return WebhookDeliveryLogOut(deliveries=[])
        # Pull a generous slice from the store, then filter by
        # visibility, then trim to ``limit``. The store does not know
        # about ownership so we must filter here.
        raw = webhook_log_store.list(
            limit=max(int(limit) * 4, 200), status=status,
            subscription_id=subscription_id)
        if not is_admin:
            raw = [r for r in raw if r.subscription_id in visible_ids]
        raw = raw[: int(limit)]
        return WebhookDeliveryLogOut(deliveries=[
            WebhookDeliveryLogItemOut(**r.to_dict()) for r in raw])

    @app.post("/webhooks/deliveries/{attempt_id}/replay",
              response_model=WebhookDeliveryLogItemOut,
              dependencies=[Depends(require_api_key)])
    def webhooks_deliveries_replay(attempt_id: str,
                                   x_api_key: str | None = Header(default=None)):
        original = webhook_log_store.get(attempt_id)
        if original is None:
            raise HTTPException(404, "attempt not found or no payload to replay")
        sub = webhooks_store.get(original.subscription_id)
        owner_id, is_admin = _webhook_caller(x_api_key)
        if sub is None or not sub.is_visible_to(owner_id, is_admin=is_admin):
            raise HTTPException(404, "attempt not found or no payload to replay")
        replayed = replay_delivery(
            attempt_id, webhooks_store, webhook_log_store,
            on_outcome=_webhook_outcome)
        if replayed is None:
            raise HTTPException(404, "attempt not found or no payload to replay")
        return WebhookDeliveryLogItemOut(**replayed.to_dict())

    @app.post("/webhooks/{sub_id}/reactivate",
              response_model=WebhookOut,
              dependencies=[Depends(require_api_key)])
    def webhooks_reactivate(sub_id: str,
                            request: Request,
                            x_api_key: str | None = Header(default=None)):
        """Clear the circuit breaker on an auto-disabled subscription.

        Returns 404 (not 403) for non-visible subscriptions so existence
        does not leak across tenants. Audit-logs the manual reactivation
        with the prior auto-disable reason for SOC2 traceability.
        """
        sub = webhooks_store.get(sub_id)
        owner_id, is_admin = _webhook_caller(x_api_key)
        if sub is None or not sub.is_visible_to(owner_id, is_admin=is_admin):
            raise HTTPException(404, "subscription not found")
        prior_reason = sub.auto_disable_reason
        prior_auto_at = sub.auto_disabled_at
        sub.enabled = True
        sub.auto_disabled_at = None
        sub.auto_disable_reason = None
        sub.consecutive_failures = 0
        webhooks_store.update(sub)
        try:
            from ..audit.log import AuditEvent as _AE_wh, _utc_now_iso as _iso_wh, _hash_key as _hk_wh
            src_ip = (request.client.host if request.client else "-") or "-"
            audit_log.record(_AE_wh(
                ts=_iso_wh(),
                request_id=request.headers.get("x-request-id", "-"),
                method="POST", path=f"/webhooks/{sub_id}/reactivate",
                status=200,
                actor_key_hash=_hk_wh(x_api_key or ""),
                actor_label="admin" if is_admin else "owner",
                source_ip=src_ip, duration_ms=0.0,
                action="webhook.reactivated",
                extra={"subscription_id": sub.id,
                       "url": sub.url,
                       "owner_key_id": sub.owner_key_id,
                       "prior_auto_disabled_at": prior_auto_at,
                       "prior_reason": prior_reason},
            ))
        except Exception:
            pass
        return WebhookOut(**sub.to_dict())

    def _drawdown_price_history():
        hist = {}
        for tk in set(t.ticker for t in portfolio_store.trades()):
            df = load_ohlcv(tk)
            if not df.empty:
                hist[tk] = df
        return hist

    @app.get("/portfolio/drawdown", response_model=DrawdownReportOut,
             dependencies=[Depends(require_api_key)])
    def portfolio_drawdown(trigger: float = 0.10, rearm: float = 0.05,
                            min_history_days: int = 5, cash: float = 0.0,
                            persist: bool = False):
        try:
            cfg = DrawdownConfig(trigger=trigger, rearm=rearm,
                                  min_history_days=min_history_days)
        except ValueError as e:
            raise HTTPException(400, str(e))
        trades = portfolio_store.trades()
        if not trades:
            raise HTTPException(404, "no trades")
        report = evaluate_guard(
            trades, _drawdown_price_history(), cfg,
            previously_tripped=drawdown_store.previously_tripped(),
            cash=cash,
        )
        if persist:
            drawdown_store.record(report.state)
        return DrawdownReportOut(**report.to_dict())

    @app.get("/portfolio/drawdown/history", dependencies=[Depends(require_api_key)])
    def portfolio_drawdown_history():
        return {"history": drawdown_store.history()}
    @app.post("/portfolio/drawdown/clear", dependencies=[Depends(require_api_key)])
    def portfolio_drawdown_clear():
        drawdown_store.clear()
        return {"ok": True}

    @app.get("/picks/guarded", response_model=DailyReportOut,
             dependencies=[Depends(require_api_key)])
    def picks_guarded(refresh: bool = False, trigger: float = 0.10,
                       rearm: float = 0.05, min_history_days: int = 5,
                       cash: float = 0.0):
        rep = run_daily(store.list(), refresh=refresh)
        trades = portfolio_store.trades()
        if trades:
            try:
                cfg = DrawdownConfig(trigger=trigger, rearm=rearm,
                                      min_history_days=min_history_days)
            except ValueError as e:
                raise HTTPException(400, str(e))
            report = evaluate_guard(
                trades, _drawdown_price_history(), cfg,
                previously_tripped=drawdown_store.previously_tripped(),
                cash=cash,
            )
            pick_dicts = drawdown_filter_picks(
                [p.to_dict() for p in rep.picks], report.state,
            )
            return DailyReportOut(
                as_of=rep.as_of,
                picks=[Pick(**p) for p in pick_dicts],
            )
        return DailyReportOut(as_of=rep.as_of,
                                picks=[Pick(**p.to_dict()) for p in rep.picks])

    @app.get("/journal", response_model=JournalListOut,
             dependencies=[Depends(require_api_key)])
    def journal_list(tag: str | None = None,
                     min_conviction: int | None = None,
                     max_conviction: int | None = None):
        rows = journal_store.list(tag=tag, min_conviction=min_conviction,
                                    max_conviction=max_conviction)
        return JournalListOut(entries=[JournalEntryOut(**e.to_dict()) for e in rows])

    @app.post("/journal", response_model=JournalEntryOut,
              dependencies=[Depends(require_api_key)])
    def journal_upsert(body: JournalEntryIn):
        # Verify trade exists
        if not any(t.id == body.trade_id for t in portfolio_store.trades()):
            raise HTTPException(404, f"trade {body.trade_id} not found")
        try:
            entry = JournalEntry(
                trade_id=body.trade_id,
                thesis=body.thesis,
                conviction=body.conviction,
                tags=list(body.tags),
                exit_reason=body.exit_reason,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        stored = journal_store.upsert(entry)
        return JournalEntryOut(**stored.to_dict())

    @app.get("/journal/stats/conviction", response_model=ConvictionStatsOut,
             dependencies=[Depends(require_api_key)])
    def journal_conviction_stats():
        buckets = conviction_stats(portfolio_store.trades(), journal_store.list())
        return ConvictionStatsOut(
            buckets=[ConvictionBucketOut(**b.to_dict()) for b in buckets],
        )

    @app.get("/journal/{trade_id}", response_model=JournalEntryOut,
             dependencies=[Depends(require_api_key)])
    def journal_get(trade_id: str):
        e = journal_store.get(trade_id)
        if e is None:
            raise HTTPException(404, "journal entry not found")
        return JournalEntryOut(**e.to_dict())

    @app.delete("/journal/{trade_id}", dependencies=[Depends(require_api_key)])
    def journal_remove(trade_id: str):
        if not journal_store.remove(trade_id):
            raise HTTPException(404, "journal entry not found")
        return {"removed": trade_id}

    @app.get("/brackets", response_model=BracketListOut,
             dependencies=[Depends(require_api_key)])
    def brackets_list(ticker: str | None = None, status: str | None = None):
        try:
            rows = bracket_store.list(ticker=ticker, status=status)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketListOut(plans=[BracketPlanOut(**p.to_dict()) for p in rows])

    @app.post("/brackets", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_create(body: BracketPlanIn):
        try:
            plan = BracketPlan(
                ticker=body.ticker, side=body.side, entry=body.entry,
                stop=body.stop, target=body.target, shares=body.shares,
                note=body.note,
            )
        except ValueError as e:
            raise HTTPException(400, str(e))
        bracket_store.add(plan)
        return BracketPlanOut(**plan.to_dict())

    @app.get("/brackets/stats", response_model=BracketStatsOut,
             dependencies=[Depends(require_api_key)])
    def brackets_stats_ep():
        stats = compute_bracket_stats(bracket_store.list())
        return BracketStatsOut(**stats.to_dict())

    @app.get("/brackets/{plan_id}", response_model=BracketPlanOut,
             dependencies=[Depends(require_api_key)])
    def brackets_get(plan_id: str):
        p = bracket_store.get(plan_id)
        if p is None:
            raise HTTPException(404, "bracket plan not found")
        return BracketPlanOut(**p.to_dict())

    @app.delete("/brackets/{plan_id}", dependencies=[Depends(require_api_key)])
    def brackets_remove(plan_id: str):
        if not bracket_store.remove(plan_id):
            raise HTTPException(404, "bracket plan not found")
        return {"removed": plan_id}

    @app.post("/brackets/{plan_id}/fill", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_fill_ep(plan_id: str, body: BracketFillIn):
        try:
            p = bracket_store.fill(plan_id, actual_entry=body.actual_entry)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.post("/brackets/{plan_id}/close", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_close_ep(plan_id: str, body: BracketCloseIn):
        try:
            p = bracket_store.close(plan_id, actual_exit=body.actual_exit, reason=body.reason)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.post("/brackets/{plan_id}/cancel", response_model=BracketPlanOut,
              dependencies=[Depends(require_api_key)])
    def brackets_cancel_ep(plan_id: str):
        try:
            p = bracket_store.cancel(plan_id)
        except KeyError:
            raise HTTPException(404, "bracket plan not found")
        except ValueError as e:
            raise HTTPException(400, str(e))
        return BracketPlanOut(**p.to_dict())

    @app.get("/fx", response_model=FxListOut, dependencies=[Depends(require_api_key)])
    def fx_list():
        return FxListOut(currencies=fx_store.currencies())

    @app.post("/fx", response_model=FxRateOut, dependencies=[Depends(require_api_key)])
    def fx_upsert(body: FxRateIn):
        cur = body.currency.upper().strip()
        if len(cur) != 3 or not cur.isalpha():
            raise HTTPException(400, "currency must be 3-letter ISO code")
        if body.rate <= 0:
            raise HTTPException(400, "rate must be positive")
        fx_store.upsert_rate(cur, body.date, body.rate)
        return FxRateOut(currency=cur, date=body.date, rate=body.rate)

    @app.get("/fx/{currency}", response_model=FxRateOut,
             dependencies=[Depends(require_api_key)])
    def fx_get(currency: str, as_of: str):
        rate = fx_store.get(currency, as_of)
        if rate is None:
            raise HTTPException(404, f"no rate for {currency} as of {as_of}")
        return FxRateOut(currency=currency.upper(), date=as_of, rate=rate)

    @app.get("/portfolio/currency", response_model=TradeCurrencyOut,
             dependencies=[Depends(require_api_key)])
    def trade_currency_list():
        return TradeCurrencyOut(map=ccy_map.all())

    @app.post("/portfolio/currency", response_model=TradeCurrencyOut,
              dependencies=[Depends(require_api_key)])
    def trade_currency_set(body: TradeCurrencyIn):
        if not any(t.id == body.trade_id for t in portfolio_store.trades()):
            raise HTTPException(404, f"trade {body.trade_id} not found")
        try:
            ccy_map.set(body.trade_id, body.currency)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return TradeCurrencyOut(map=ccy_map.all())

    @app.delete("/portfolio/currency/{trade_id}",
                dependencies=[Depends(require_api_key)])
    def trade_currency_remove(trade_id: str):
        if not ccy_map.remove(trade_id):
            raise HTTPException(404, "trade currency not set")
        return {"removed": trade_id}

    @app.get("/portfolio/converted", response_model=ConvertedTradesOut,
             dependencies=[Depends(require_api_key)])
    def portfolio_converted(base: str = "USD"):
        if base.upper() != USD:
            raise HTTPException(400, "only USD base currency supported")
        trades = portfolio_store.trades()
        audits = convert_trades(trades, ccy_map, fx_store, base=USD)
        rows = [audit.to_dict() for audit in audits.values()]
        total_base = sum(a["base_amount"] or 0.0 for a in rows)
        total_fallback = sum(a["native_amount"] for a in rows if a["fallback"])
        return ConvertedTradesOut(
            base=USD,
            audits=[ConversionAuditOut(**a) for a in rows],
            total_base_cost=total_base,
            total_fallback_native=total_fallback,
        )

    @app.get("/notifier/dlq", response_model=DeadLetterListOut,
             dependencies=[Depends(require_api_key)])
    def dlq_list(channel: str | None = None):
        items = dlq.list(channel=channel)
        return DeadLetterListOut(items=[DeadLetterOut(**i.to_dict()) for i in items])

    @app.delete("/notifier/dlq/{item_id}", dependencies=[Depends(require_api_key)])
    def dlq_remove(item_id: str):
        if not dlq.remove(item_id):
            raise HTTPException(404, "item not found")
        return {"removed": item_id}

    @app.post("/notifier/dlq/replay", response_model=DlqReplayOut,
              dependencies=[Depends(require_api_key)])
    def dlq_replay():
        counts = replay_dlq(
            dlq, _notifier_for,
            policy=RetryPolicy(max_attempts=2, initial_delay=0.5, jitter=0.0),
        )
        return DlqReplayOut(**counts)

    @app.post("/notifier/test", dependencies=[Depends(require_api_key)])
    def notifier_test(body: NotifyTestIn):
        n = _notifier_for(body.channel)
        if n is None:
            raise HTTPException(400,
                                  f"unknown channel '{body.channel}'")
        ok = send_with_retry(
            n, body.text, channel=body.channel.lower(),
            policy=RetryPolicy(max_attempts=2, initial_delay=0, jitter=0.0),
            dlq=dlq,
        )
        return {"channel": body.channel.lower(), "ok": ok}

    def _store_bundle() -> StoreBundle:
        return StoreBundle(
            data_dir=settings.data_dir,
            watchlist=store,
            alerts=alert_store,
            portfolio=portfolio_store,
            stops=stops_store,
            earnings=earnings_store,
            journal=journal_store,
            brackets=bracket_store,
            news_events=news_event_store,
            webhooks=webhooks_store,
            drawdown=drawdown_store,
            fx=fx_store,
            ccy_map=ccy_map,
            dlq=dlq,
            ledger=ledger_store,
            scaling=scaling_store,
            archive=archive,
            audit=audit_log,
        )

    # ------------------------------------------------------------------
    # Legal hold (eDiscovery / regulator-ordered preservation)
    # ------------------------------------------------------------------
    from ..audit.log import AuditEvent as _AE_lh, _hash_key as _hk_lh, _utc_now_iso as _now_iso_lh

    @app.get(
        "/admin/legal-hold",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_legal_hold_list():
        return {"holds": [h.to_dict() for h in legal_hold_store.list()]}

    @app.post(
        "/admin/legal-hold",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_legal_hold_place(
        request: Request,
        body: LegalHoldIn = Body(...),
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        try:
            hold = legal_hold_store.place(
                body.key_hash,
                reason=body.reason,
                placed_by=actor,
                case_id=body.case_id,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method="POST", path="/admin/legal-hold", status=200,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action="legal_hold.place",
            extra={"key_hash": hold.key_hash, "case_id": hold.case_id,
                   "reason": hold.reason[:200]},
        ))
        return hold.to_dict()

    @app.delete(
        "/admin/legal-hold/{key_hash}",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_legal_hold_release(
        key_hash: str,
        request: Request,
        x_api_key: str | None = Header(default=None),
    ):
        existed = legal_hold_store.release(key_hash)
        if not existed:
            raise HTTPException(404, "no active hold for that key_hash")
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method="DELETE", path=f"/admin/legal-hold/{key_hash}", status=200,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action="legal_hold.release",
            extra={"key_hash": key_hash.strip().lower()},
        ))
        return {"ok": True, "key_hash": key_hash.strip().lower()}

    # ------------------------------------------------------------------
    # Trust Center: public subprocessor registry + admin CRUD
    # ------------------------------------------------------------------
    # The public reads (/trust/subprocessors and history) are
    # intentionally unauthenticated so prospects and DPA reviewers can
    # fetch them without a login. Mutations require admin scope + MFA
    # and every change is recorded both in the registry's own change
    # log and in the global audit chain.
    @app.get("/trust/subprocessors")
    def trust_subprocessors_public():
        snap = subprocessor_store.snapshot()
        return snap.to_public()

    @app.get("/trust/subprocessors/history")
    def trust_subprocessors_history(limit: int = 100):
        return {"changes": subprocessor_store.history(limit=limit)}

    @app.get(
        "/admin/subprocessors",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_subprocessors_list():
        snap = subprocessor_store.snapshot()
        return snap.to_public()

    @app.post(
        "/admin/subprocessors",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_subprocessors_add(
        request: Request,
        body: SubprocessorIn = Body(...),
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        if not body.name or not body.purpose or not body.country or not body.url:
            raise HTTPException(400, "name, purpose, country, and url are required")
        try:
            entry = subprocessor_store.add(
                name=body.name, purpose=body.purpose, country=body.country,
                url=body.url, data_categories=body.data_categories or [],
                actor=actor,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method="POST", path="/admin/subprocessors", status=200,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action="subprocessor.add",
            extra={"id": entry.id, "name": entry.name, "country": entry.country},
        ))
        return entry.to_public()

    @app.put(
        "/admin/subprocessors/{entry_id}",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_subprocessors_update(
        entry_id: str,
        request: Request,
        body: SubprocessorIn = Body(...),
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        try:
            entry = subprocessor_store.update(
                entry_id,
                name=body.name, purpose=body.purpose, country=body.country,
                url=body.url, data_categories=body.data_categories,
                actor=actor,
            )
        except KeyError:
            raise HTTPException(404, f"subprocessor {entry_id!r} not found")
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method="PUT", path=f"/admin/subprocessors/{entry_id}", status=200,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action="subprocessor.update",
            extra={"id": entry.id},
        ))
        return entry.to_public()

    @app.delete(
        "/admin/subprocessors/{entry_id}",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_subprocessors_remove(
        entry_id: str,
        request: Request,
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        try:
            removed = subprocessor_store.remove(entry_id, actor=actor)
        except KeyError:
            raise HTTPException(404, f"subprocessor {entry_id!r} not found")
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method="DELETE", path=f"/admin/subprocessors/{entry_id}", status=200,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action="subprocessor.remove",
            extra={"id": removed.id, "name": removed.name},
        ))
        return {"ok": True, "id": removed.id}

    # ------------------------------------------------------------------
    # Break-glass: time-boxed emergency admin elevation
    # ------------------------------------------------------------------
    # An admin grants a non-admin key the ``admin`` scope for at most
    # ``MAX_TTL_SECONDS`` so an on-call engineer can fix an incident
    # without the operator handing out a permanent admin key. The
    # grant is enforced inside ``_resolve_key`` (rate_limit.py) so it
    # applies uniformly to every middleware check and route
    # dependency. Issuance, revocation, and use are all audited.
    from ..break_glass import (
        get_store as _bg_get_store,
        hash_key as _bg_hash_key,
        MAX_TTL_SECONDS as _BG_MAX_TTL,
        MIN_TTL_SECONDS as _BG_MIN_TTL,
    )

    def _bg_audit(request: Request, *, action: str, status_code: int,
                  path_: str, method_: str, actor: str,
                  extra: dict):
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE_lh(
            ts=_now_iso_lh(),
            request_id=request.headers.get("x-request-id", "-"),
            method=method_, path=path_, status=status_code,
            actor_key_hash=actor, actor_label="admin", source_ip=src_ip,
            duration_ms=0.0, action=action, extra=extra,
        ))

    @app.get(
        "/admin/break-glass",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_break_glass_list(include_inactive: bool = True):
        store_ = _bg_get_store()
        rows = store_.list_grants(include_inactive=include_inactive)
        return {
            "max_ttl_seconds": _BG_MAX_TTL,
            "min_ttl_seconds": _BG_MIN_TTL,
            "grants": [r.to_public() for r in rows],
        }

    @app.post(
        "/admin/break-glass",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_break_glass_grant(
        request: Request,
        body: dict = Body(...),
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        target_secret = (body or {}).get("target_api_key")
        target_hash = (body or {}).get("target_key_hash")
        target_label = str((body or {}).get("target_label", "") or "")
        reason = (body or {}).get("reason")
        ttl = (body or {}).get("ttl_seconds")
        if not target_secret and not target_hash:
            raise HTTPException(400,
                "target_api_key or target_key_hash is required")
        if target_secret and not target_hash:
            target_hash = _bg_hash_key(str(target_secret))
        try:
            grant = _bg_get_store().grant(
                target_key_hash=str(target_hash),
                target_label=target_label,
                reason=str(reason or ""),
                ttl_seconds=int(ttl) if ttl is not None else 0,
                granted_by_hash=actor,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        _bg_audit(request, action="break_glass.grant", status_code=200,
                  method_="POST", path_="/admin/break-glass",
                  actor=actor,
                  extra={
                      "id": grant.id,
                      "target_key_hash": grant.target_key_hash,
                      "expires_at": grant.expires_at,
                      "reason": grant.reason[:120],
                  })
        return grant.to_public()

    @app.post(
        "/admin/break-glass/{grant_id}/revoke",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_break_glass_revoke(
        grant_id: str,
        request: Request,
        x_api_key: str | None = Header(default=None),
    ):
        actor = _hk_lh(x_api_key) if x_api_key else "-"
        store_ = _bg_get_store()
        existing = store_.get(grant_id)
        if existing is None:
            raise HTTPException(404, f"grant {grant_id!r} not found")
        revoked = store_.revoke(grant_id, revoked_by_hash=actor)
        _bg_audit(request, action="break_glass.revoke", status_code=200,
                  method_="POST",
                  path_=f"/admin/break-glass/{grant_id}/revoke",
                  actor=actor,
                  extra={"id": grant_id,
                         "target_key_hash": existing.target_key_hash})
        return (revoked or existing).to_public()

    @app.get("/break-glass/me")
    def admin_break_glass_me(x_api_key: str | None = Header(default=None)):
        if not x_api_key:
            return {"active": False, "grant": None}
        live = _bg_get_store().live_for(_bg_hash_key(x_api_key))
        if live is None:
            return {"active": False, "grant": None}
        return {"active": True, "grant": live.to_public()}

    @app.get("/privacy/export",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def privacy_export(format: str = "json"):
        """Return every user-state record (GDPR Article 20).

        Requires the ``admin`` scope on the calling API key. Output
        contains watchlist, alerts, portfolio trades, stops, journal,
        brackets, earnings calendar, news events, webhooks, drawdown
        history, scaling plans, FX currencies, and the full persisted
        audit log grouped by UTC day.

        Supported ``format`` values:

        * ``json`` (default): a single JSON document.
        * ``zip`` / ``csv``: a ZIP bundle containing one CSV per
          store plus a MANIFEST.txt and (for ``zip``) the raw JSON.
          ``csv`` produces the same bundle without the JSON blob.
        """
        fmt = (format or "json").lower().strip()
        if fmt not in ("json", "zip", "csv"):
            raise HTTPException(400, "format must be one of: json, zip, csv")
        bundle = collect_user_data(_store_bundle())
        if fmt == "json":
            return bundle
        from fastapi.responses import Response
        blob = _build_export_zip(bundle, include_json=(fmt == "zip"))
        fname = _export_filename(fmt)
        log.info("privacy.export", format=fmt, bytes=len(blob),
                 stores=sum(1 for k in bundle if isinstance(bundle.get(k), list)))
        return Response(
            content=blob,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @app.post("/privacy/delete",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def privacy_delete(confirm: str = "",
                       wipe_audit: bool = False,
                       wipe_reports: bool = False,
                       wipe_ohlcv: bool = False):
        """Erase user-state stores (GDPR Article 17).

        Caller must pass ``confirm=DELETE`` (exact, case-sensitive) to
        avoid accidental wipes. Audit log, archived reports, and
        cached OHLCV are preserved by default since they are typically
        retained for compliance; opt in per-category with the flags.
        """
        if confirm != "DELETE":
            raise HTTPException(400, "pass confirm=DELETE to proceed")
        if legal_hold_store.any_active():
            held = [h.key_hash for h in legal_hold_store.list()]
            raise HTTPException(
                409,
                {
                    "error": "legal_hold_active",
                    "message": (
                        "deletion refused: one or more legal holds are "
                        "active. Release via DELETE /admin/legal-hold/{key_hash} "
                        "before erasing."
                    ),
                    "holds": held,
                },
            )
        summary = erase_user_data(
            _store_bundle(),
            wipe_audit=wipe_audit,
            wipe_reports=wipe_reports,
            wipe_ohlcv=wipe_ohlcv,
        )
        log.info("privacy.delete", **summary.to_dict())
        return summary.to_dict()

    # -------------------------------------------------------------------
    # SSO (OIDC) -- admin config + browser-driven login flow
    # -------------------------------------------------------------------
    from fastapi import Request as _Req
    from fastapi.responses import RedirectResponse as _Redir, JSONResponse as _Json
    from pydantic import BaseModel as _BM, Field as _Fld
    from ..audit.log import AuditEvent as _AE, _hash_key as _hk, _utc_now_iso as _now_iso
    from ..api_keys import StoredKey  # noqa: F401  (type only, not used)

    class _OidcConfigIn(_BM):
        enabled: bool = False
        issuer: str = ""
        client_id: str = ""
        client_secret: str | None = None
        redirect_uri: str = ""
        allowed_email_domains: list[str] = _Fld(default_factory=list)
        default_role: str = "viewer"
        default_scopes: list[str] = _Fld(default_factory=lambda: ["read"])

    @app.get(
        "/admin/sso",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_sso_get():
        return oidc_store.get().public_dict()

    from fastapi import Body as _Body
    @app.put(
        "/admin/sso",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_sso_put(body: _OidcConfigIn = _Body(...)):
        current = oidc_store.get()
        # Allow rotating any field; if client_secret is omitted or
        # equals the redaction placeholder, keep the stored value so
        # the UI can PUT back what GET returned without leaking it.
        new_secret = body.client_secret
        if new_secret is None or new_secret == "***redacted***":
            new_secret = current.client_secret
        cfg = OidcConfig(
            enabled=bool(body.enabled),
            issuer=body.issuer.strip(),
            client_id=body.client_id.strip(),
            client_secret=new_secret or "",
            redirect_uri=body.redirect_uri.strip(),
            allowed_email_domains=list(body.allowed_email_domains or []),
            default_role=body.default_role or "viewer",
            default_scopes=list(body.default_scopes or ["read"]),
        )
        try:
            saved = oidc_store.put(cfg)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return saved.public_dict()

    @app.delete(
        "/admin/sso",
        dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)],
    )
    def admin_sso_delete():
        oidc_store.clear()
        return {"ok": True}

    def _sso_client() -> OidcClient:
        cfg = oidc_store.get()
        if not cfg.enabled:
            raise HTTPException(404, "sso not configured")
        # Allow tests to inject a fake client by attaching one to
        # app.state.oidc_client_factory; production uses a fresh client
        # per request which keeps connection state out of process globals.
        factory = getattr(app.state, "oidc_client_factory", None)
        if factory is not None:
            return factory(cfg)
        return OidcClient(cfg)

    @app.get("/auth/sso/login")
    def sso_login(return_to: str = "/"):
        client = _sso_client()
        rec = oidc_state.issue(return_to=return_to)
        try:
            url = client.authorization_url(rec)
        except OidcError as exc:
            raise HTTPException(502, f"oidc discovery failed: {exc}")
        return _Redir(url, status_code=302)

    @app.get("/auth/sso/callback")
    def sso_callback(request: _Req, code: str | None = None, state: str | None = None, error: str | None = None):
        cfg = oidc_store.get()
        if not cfg.enabled:
            raise HTTPException(404, "sso not configured")
        src_ip = (request.client.host if request.client else "-") or "-"
        if error:
            audit_log.record(_AE(
                ts=_now_iso(), request_id=request.headers.get("x-request-id", "-"),
                method="GET", path="/auth/sso/callback", status=400,
                actor_key_hash="-", actor_label="sso", source_ip=src_ip,
                duration_ms=0.0, action="sso.callback.error",
                extra={"error": error[:200]},
            ))
            raise HTTPException(400, f"idp error: {error}")
        if not code or not state:
            raise HTTPException(400, "missing code or state")
        rec = oidc_state.consume(state)
        if rec is None:
            audit_log.record(_AE(
                ts=_now_iso(), request_id=request.headers.get("x-request-id", "-"),
                method="GET", path="/auth/sso/callback", status=400,
                actor_key_hash="-", actor_label="sso", source_ip=src_ip,
                duration_ms=0.0, action="sso.callback.invalid_state", extra={},
            ))
            raise HTTPException(400, "invalid or expired state")
        client = _sso_client()
        try:
            token_resp = client.exchange_code(code, rec)
            userinfo = None
            try:
                if token_resp.get("access_token"):
                    userinfo = client.userinfo(token_resp["access_token"])
            except OidcError:
                # userinfo is optional; we fall back to id_token claims
                userinfo = None
            email = _oidc_extract_email(token_resp, userinfo)
        except OidcError as exc:
            audit_log.record(_AE(
                ts=_now_iso(), request_id=request.headers.get("x-request-id", "-"),
                method="GET", path="/auth/sso/callback", status=502,
                actor_key_hash="-", actor_label="sso", source_ip=src_ip,
                duration_ms=0.0, action="sso.exchange_failed",
                extra={"reason": str(exc)[:200]},
            ))
            raise HTTPException(502, f"oidc exchange failed: {exc}")
        if not _oidc_email_allowed(email, cfg.allowed_email_domains):
            audit_log.record(_AE(
                ts=_now_iso(), request_id=request.headers.get("x-request-id", "-"),
                method="GET", path="/auth/sso/callback", status=403,
                actor_key_hash="-", actor_label="sso", source_ip=src_ip,
                duration_ms=0.0, action="sso.email_not_allowed",
                extra={"email": email},
            ))
            raise HTTPException(403, f"email domain not on allowlist: {email}")
        label = f"sso:{email}"
        rec_key, secret = api_key_store.create(
            label=label,
            scopes=list(cfg.default_scopes),
            role=cfg.default_role,
        )
        audit_log.record(_AE(
            ts=_now_iso(), request_id=request.headers.get("x-request-id", "-"),
            method="GET", path="/auth/sso/callback", status=200,
            actor_key_hash=_hk(secret), actor_label=label, source_ip=src_ip,
            duration_ms=0.0, action="sso.login.success",
            extra={
                "email": email,
                "key_id": rec_key.id,
                "role": rec_key.role,
                "scopes": rec_key.scopes,
            },
        ))
        return _Json({
            "ok": True,
            "email": email,
            "key_id": rec_key.id,
            "label": rec_key.label,
            "role": rec_key.role,
            "scopes": rec_key.scopes,
            "secret": secret,
            "return_to": rec.return_to,
            "note": "Store this secret now. It will not be shown again.",
        })

    # -------------------------------------------------------------------
    # SCIM 2.0 -- automated user provisioning for Okta / Entra / etc.
    # -------------------------------------------------------------------
    from fastapi.responses import JSONResponse as _SJson
    from fastapi import Request as _ScimReq
    from ..api_keys import ROLE_SCOPES as _ROLE_SCOPES, ROLES as _ROLES
    # Expose to module globals so FastAPI's annotation resolver (which
    # runs against the module dict under ``from __future__ import
    # annotations``) can dereference the local alias.
    globals()["_ScimReq"] = _ScimReq

    SCIM_CT = "application/scim+json"

    def _scim_resp(body, status: int = 200):
        return _SJson(body, status_code=status, media_type=SCIM_CT)

    def _scim_audit(request: _ScimReq, action: str, status: int, extra: dict, *, label: str = "scim"):
        src_ip = (request.client.host if request.client else "-") or "-"
        audit_log.record(_AE(
            ts=_now_iso(),
            request_id=request.headers.get("x-request-id", "-"),
            method=request.method,
            path=request.url.path,
            status=status,
            actor_key_hash="-",
            actor_label=label,
            source_ip=src_ip,
            duration_ms=0.0,
            action=action,
            extra=extra,
        ))

    def _require_scim(request: _ScimReq):
        auth = request.headers.get("authorization") or ""
        token = ""
        if auth.lower().startswith("bearer "):
            token = auth.split(" ", 1)[1].strip()
        cfg = scim_cfg_store.get()
        if not cfg.enabled or not cfg.bearer_hash:
            _scim_audit(request, "scim.auth.disabled", 404, {})
            raise HTTPException(status_code=404, detail="scim not configured")
        if not token or not scim_cfg_store.verify_bearer(token):
            _scim_audit(request, "scim.auth.unauthorized", 401, {})
            raise HTTPException(status_code=401, detail="invalid scim bearer")
        return True

    def _scim_base(request: _ScimReq) -> str:
        # Build the resource ``meta.location`` base from the request so
        # the IdP can dereference users behind a reverse proxy.
        return str(request.base_url).rstrip("/") + "/scim/v2"

    @app.get("/scim/v2/ServiceProviderConfig", include_in_schema=False)
    def scim_spc(request: _ScimReq):
        # Public per RFC 7644 §4; advertises features only.
        return _scim_resp(_scim_spc())

    @app.get("/scim/v2/ResourceTypes", include_in_schema=False)
    def scim_resource_types(request: _ScimReq):
        return _scim_resp(_scim_rts())

    @app.get("/scim/v2/Users", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    def scim_list_users(request: _ScimReq, filter: str | None = None,
                       startIndex: int = 1, count: int = 100):
        # Minimal filter support: ``userName eq "x"`` (Okta/Entra send this).
        uname: str | None = None
        if filter:
            f = filter.strip()
            # crude but RFC-compliant for the only filter the IdPs send
            if f.lower().startswith("username eq "):
                rhs = f[len("userName eq "):].strip()
                if rhs.startswith('"') and rhs.endswith('"'):
                    uname = rhs[1:-1]
        rows = scim_user_store.list(filter_username=uname)
        base = _scim_base(request)
        # paginate
        try:
            start = max(1, int(startIndex))
            cnt = max(0, min(int(count), 200))
        except (TypeError, ValueError):
            start, cnt = 1, 100
        page = rows[start - 1 : start - 1 + cnt]
        return _scim_resp({
            "schemas": [_SCIM_LIST],
            "totalResults": len(rows),
            "startIndex": start,
            "itemsPerPage": len(page),
            "Resources": [_scim_user(u, location_base=base) for u in page],
        })

    @app.get("/scim/v2/Users/{user_id}", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    def scim_get_user(user_id: str, request: _ScimReq):
        u = scim_user_store.get(user_id)
        if not u:
            return _scim_resp(_scim_error("User not found", 404), 404)
        return _scim_resp(_scim_user(u, location_base=_scim_base(request)))

    @app.post("/scim/v2/Users", include_in_schema=False,
              dependencies=[Depends(_require_scim)])
    async def scim_create_user(request: _ScimReq):
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        uname = _scim_uname(payload)
        if not uname:
            return _scim_resp(_scim_error("userName required", 400, "invalidValue"), 400)
        if scim_user_store.get_by_username(uname) is not None:
            return _scim_resp(_scim_error("userName already exists", 409, "uniqueness"), 409)
        external_id = str(payload.get("externalId") or "")
        display_name = str(payload.get("displayName") or uname)
        email = _scim_email(payload)
        active = payload.get("active", True)
        if not isinstance(active, bool):
            active = str(active).lower() == "true"
        cfg = scim_cfg_store.get()
        role = cfg.default_role if cfg.default_role in _ROLES else "member"
        allowed = _ROLE_SCOPES[role]
        scopes = [s for s in cfg.default_scopes if s in allowed] or ["read"]
        if "admin" in allowed:
            scopes = sorted(set(scopes) | {"admin"})
        # Mint a real api key. Label includes the IdP user so an admin
        # can correlate the key with the source-of-truth account.
        rec_key, secret = api_key_store.create(
            label=f"scim:{uname}", scopes=scopes, role=role,
        )
        if not active:
            # SCIM caller created an already-inactive user; revoke the
            # key immediately so it cannot be used. (Some IdPs do this
            # during initial sync before group assignment.)
            api_key_store.revoke(rec_key.id)
        try:
            row = scim_user_store.create(
                user_name=uname,
                external_id=external_id,
                display_name=display_name,
                email=email,
                active=bool(active),
                key_id=rec_key.id,
            )
        except ValueError as exc:
            api_key_store.revoke(rec_key.id)
            return _scim_resp(_scim_error(str(exc), 409, "uniqueness"), 409)
        _scim_audit(request, "scim.user.create", 201, {
            "user_id": row.id, "user_name": uname,
            "external_id": external_id, "key_id": rec_key.id,
            "active": bool(active), "role": role,
        }, label=f"scim:{uname}")
        body = _scim_user(row, location_base=_scim_base(request))
        # SCIM never returns secrets in the resource. Surface the
        # one-time api key secret via an out-of-band ``urn:signalclaw``
        # extension schema so an operator running the call by hand can
        # capture it; production IdP connectors ignore unknown schemas.
        body["schemas"] = list(body["schemas"]) + ["urn:signalclaw:scim:extension:1.0"]
        body["urn:signalclaw:scim:extension:1.0"] = {
            "apiKeySecret": secret,
            "apiKeyId": rec_key.id,
            "note": "Store this secret now. It will not be shown again.",
        }
        return _scim_resp(body, 201)

    @app.put("/scim/v2/Users/{user_id}", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    async def scim_replace_user(user_id: str, request: _ScimReq):
        existing = scim_user_store.get(user_id)
        if not existing:
            return _scim_resp(_scim_error("User not found", 404), 404)
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        uname = _scim_uname(payload) or existing.user_name
        display_name = str(payload.get("displayName") or existing.display_name)
        external_id = str(payload.get("externalId") or existing.external_id)
        email = _scim_email(payload) or existing.email
        active_in = payload.get("active", existing.active)
        if isinstance(active_in, str):
            active_in = active_in.lower() == "true"
        active = bool(active_in)
        # Sync key activation state with SCIM ``active``.
        if active and not existing.active:
            # Re-activating a previously-disabled SCIM user. We mint a
            # fresh api key (the prior one was hard-revoked) and audit.
            rec_key, secret = api_key_store.create(
                label=f"scim:{uname}",
                scopes=list(scim_cfg_store.get().default_scopes) or ["read"],
                role=scim_cfg_store.get().default_role,
            )
            row = scim_user_store.replace(
                user_id,
                user_name=uname, display_name=display_name,
                external_id=external_id, email=email,
                active=True, key_id=rec_key.id,
            )
            _scim_audit(request, "scim.user.reactivate", 200, {
                "user_id": user_id, "key_id": rec_key.id,
            }, label=f"scim:{uname}")
            body = _scim_user(row, location_base=_scim_base(request))
            body["schemas"] = list(body["schemas"]) + ["urn:signalclaw:scim:extension:1.0"]
            body["urn:signalclaw:scim:extension:1.0"] = {
                "apiKeySecret": secret, "apiKeyId": rec_key.id,
                "note": "Store this secret now. It will not be shown again.",
            }
            return _scim_resp(body, 200)
        if not active and existing.active:
            # Deactivation: hard-revoke the bound api key. SCIM does
            # not require deletion of the user resource, so the row
            # stays for audit but the credential is dead.
            api_key_store.revoke(existing.key_id)
            _scim_audit(request, "scim.user.deactivate", 200, {
                "user_id": user_id, "key_id": existing.key_id,
            }, label=f"scim:{uname}")
        row = scim_user_store.replace(
            user_id,
            user_name=uname, display_name=display_name,
            external_id=external_id, email=email, active=active,
        )
        _scim_audit(request, "scim.user.replace", 200, {
            "user_id": user_id, "active": active,
        }, label=f"scim:{uname}")
        return _scim_resp(_scim_user(row, location_base=_scim_base(request)))

    @app.patch("/scim/v2/Users/{user_id}", include_in_schema=False,
               dependencies=[Depends(_require_scim)])
    async def scim_patch_user(user_id: str, request: _ScimReq):
        existing = scim_user_store.get(user_id)
        if not existing:
            return _scim_resp(_scim_error("User not found", 404), 404)
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        changes = _scim_patch(payload)
        if not changes:
            return _scim_resp(_scim_user(existing, location_base=_scim_base(request)))
        new_active = changes.get("active", existing.active)
        # Same activation semantics as PUT: deactivate revokes, reactivate mints.
        if not new_active and existing.active:
            api_key_store.revoke(existing.key_id)
            _scim_audit(request, "scim.user.deactivate", 200, {
                "user_id": user_id, "key_id": existing.key_id,
            }, label=f"scim:{existing.user_name}")
            row = scim_user_store.replace(user_id, **changes)
            return _scim_resp(_scim_user(row, location_base=_scim_base(request)))
        if new_active and not existing.active:
            rec_key, secret = api_key_store.create(
                label=f"scim:{existing.user_name}",
                scopes=list(scim_cfg_store.get().default_scopes) or ["read"],
                role=scim_cfg_store.get().default_role,
            )
            changes["key_id"] = rec_key.id
            row = scim_user_store.replace(user_id, **changes)
            _scim_audit(request, "scim.user.reactivate", 200, {
                "user_id": user_id, "key_id": rec_key.id,
            }, label=f"scim:{existing.user_name}")
            body = _scim_user(row, location_base=_scim_base(request))
            body["schemas"] = list(body["schemas"]) + ["urn:signalclaw:scim:extension:1.0"]
            body["urn:signalclaw:scim:extension:1.0"] = {
                "apiKeySecret": secret, "apiKeyId": rec_key.id,
                "note": "Store this secret now. It will not be shown again.",
            }
            return _scim_resp(body, 200)
        row = scim_user_store.replace(user_id, **changes)
        _scim_audit(request, "scim.user.patch", 200, {
            "user_id": user_id, "fields": sorted(changes.keys()),
        }, label=f"scim:{existing.user_name}")
        return _scim_resp(_scim_user(row, location_base=_scim_base(request)))

    @app.delete("/scim/v2/Users/{user_id}", include_in_schema=False,
                dependencies=[Depends(_require_scim)])
    def scim_delete_user(user_id: str, request: _ScimReq):
        existing = scim_user_store.get(user_id)
        if not existing:
            return _scim_resp(_scim_error("User not found", 404), 404)
        api_key_store.revoke(existing.key_id)
        scim_user_store.delete(user_id)
        _scim_audit(request, "scim.user.delete", 204, {
            "user_id": user_id, "key_id": existing.key_id,
            "user_name": existing.user_name,
        }, label=f"scim:{existing.user_name}")
        # Cascade: drop the deleted user from any groups so reconcilers
        # never see dangling members.
        for g in scim_group_store.groups_for_user(user_id):
            scim_group_store.remove_member(g.id, user_id)
        from fastapi.responses import Response as _NCResp
        return _NCResp(status_code=204)

    # -------------------------------------------------------------------
    # SCIM Groups: bind role to membership.
    # -------------------------------------------------------------------
    # Role precedence (higher wins) when a user belongs to multiple groups.
    _ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}

    def _reconcile_user_role(user_id: str, *, request: _ScimReq) -> None:
        """Recompute the bound api key's role from group membership.

        Picks the highest-precedence role across all groups the user
        belongs to; if the user is in no groups, falls back to the
        SCIM default role. Writes an audit row only if the role
        actually changed.
        """
        user = scim_user_store.get(user_id)
        if user is None or not user.active:
            return
        groups = scim_group_store.groups_for_user(user_id)
        if groups:
            best = max(
                groups,
                key=lambda g: _ROLE_RANK.get(g.role, -1),
            )
            target_role = best.role if best.role in _ROLES else "member"
        else:
            cfg = scim_cfg_store.get()
            target_role = cfg.default_role if cfg.default_role in _ROLES else "member"
        try:
            stored = next(
                (k for k in api_key_store.list() if getattr(k, "id", None) == user.key_id),
                None,
            )
        except Exception:
            stored = None
        current_role = getattr(stored, "role", None) if stored is not None else None
        if current_role == target_role:
            return
        try:
            api_key_store.set_role(user.key_id, target_role)
        except Exception as exc:
            _scim_audit(request, "scim.group.role_reconcile_failed", 500, {
                "user_id": user_id, "key_id": user.key_id,
                "target_role": target_role, "error": str(exc),
            }, label=f"scim:{user.user_name}")
            return
        _scim_audit(request, "scim.group.role_reconcile", 200, {
            "user_id": user_id, "key_id": user.key_id,
            "from": current_role, "to": target_role,
        }, label=f"scim:{user.user_name}")

    def _validate_group_role(payload: dict) -> str:
        ext = payload.get("urn:signalclaw:scim:extension:1.0") or {}
        role_in = (ext.get("role") if isinstance(ext, dict) else None) or payload.get("role") or "member"
        role = str(role_in).strip().lower()
        if role not in _ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"role must be one of {sorted(_ROLES)}",
            )
        return role

    @app.get("/scim/v2/Groups", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    def scim_list_groups(request: _ScimReq, filter: str | None = None,
                         startIndex: int = 1, count: int = 100):
        display: str | None = None
        if filter:
            f = filter.strip()
            if f.lower().startswith("displayname eq "):
                rhs = f[len("displayName eq "):].strip()
                if rhs.startswith('"') and rhs.endswith('"'):
                    display = rhs[1:-1]
        rows = scim_group_store.list(filter_display_name=display)
        base = _scim_base(request)
        try:
            start = max(1, int(startIndex))
            cnt = max(0, min(int(count), 200))
        except (TypeError, ValueError):
            start, cnt = 1, 100
        page = rows[start - 1 : start - 1 + cnt]
        return _scim_resp({
            "schemas": [_SCIM_LIST],
            "totalResults": len(rows),
            "startIndex": start,
            "itemsPerPage": len(page),
            "Resources": [
                _scim_group(g, location_base=base, member_resolver=scim_user_store.get)
                for g in page
            ],
        })

    @app.get("/scim/v2/Groups/{group_id}", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    def scim_get_group(group_id: str, request: _ScimReq):
        g = scim_group_store.get(group_id)
        if not g:
            return _scim_resp(_scim_error("Group not found", 404), 404)
        return _scim_resp(_scim_group(g, location_base=_scim_base(request),
                                     member_resolver=scim_user_store.get))

    @app.post("/scim/v2/Groups", include_in_schema=False,
              dependencies=[Depends(_require_scim)])
    async def scim_create_group(request: _ScimReq):
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        display_name = payload.get("displayName")
        if not isinstance(display_name, str) or not display_name.strip():
            return _scim_resp(_scim_error("displayName required", 400, "invalidValue"), 400)
        display_name = display_name.strip()
        if scim_group_store.get_by_display_name(display_name) is not None:
            return _scim_resp(_scim_error("displayName already exists", 409, "uniqueness"), 409)
        try:
            role = _validate_group_role(payload)
        except HTTPException as exc:
            return _scim_resp(_scim_error(exc.detail, exc.status_code, "invalidValue"), exc.status_code)
        external_id = str(payload.get("externalId") or "")
        members_in = payload.get("members") or []
        member_ids: list[str] = []
        if isinstance(members_in, list):
            for m in members_in:
                if isinstance(m, dict) and isinstance(m.get("value"), str):
                    if scim_user_store.get(m["value"]) is not None:
                        member_ids.append(m["value"])
        try:
            row = scim_group_store.create(
                display_name=display_name,
                external_id=external_id,
                role=role,
                members=member_ids,
            )
        except ValueError as exc:
            return _scim_resp(_scim_error(str(exc), 409, "uniqueness"), 409)
        _scim_audit(request, "scim.group.create", 201, {
            "group_id": row.id, "display_name": display_name,
            "role": role, "members": list(member_ids),
            "external_id": external_id,
        }, label=f"scim:group:{display_name}")
        for uid in member_ids:
            _reconcile_user_role(uid, request=request)
        return _scim_resp(
            _scim_group(row, location_base=_scim_base(request),
                       member_resolver=scim_user_store.get),
            201,
        )

    @app.put("/scim/v2/Groups/{group_id}", include_in_schema=False,
             dependencies=[Depends(_require_scim)])
    async def scim_replace_group(group_id: str, request: _ScimReq):
        existing = scim_group_store.get(group_id)
        if not existing:
            return _scim_resp(_scim_error("Group not found", 404), 404)
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        display_name_in = payload.get("displayName")
        display_name = (display_name_in.strip() if isinstance(display_name_in, str) and display_name_in.strip()
                        else existing.display_name)
        external_id = str(payload.get("externalId") or existing.external_id)
        try:
            role = _validate_group_role(payload) if (
                payload.get("urn:signalclaw:scim:extension:1.0") or payload.get("role")
            ) else existing.role
        except HTTPException as exc:
            return _scim_resp(_scim_error(exc.detail, exc.status_code, "invalidValue"), exc.status_code)
        prior_members = set(existing.members)
        members_in = payload.get("members")
        if isinstance(members_in, list):
            new_members: list[str] = []
            for m in members_in:
                if isinstance(m, dict) and isinstance(m.get("value"), str):
                    if scim_user_store.get(m["value"]) is not None:
                        new_members.append(m["value"])
        else:
            new_members = list(existing.members)
        row = scim_group_store.replace(
            group_id,
            display_name=display_name,
            external_id=external_id,
            role=role,
            members=new_members,
        )
        touched = prior_members | set(new_members)
        _scim_audit(request, "scim.group.replace", 200, {
            "group_id": group_id, "display_name": display_name,
            "role": role, "members": list(new_members),
            "role_changed": role != existing.role,
        }, label=f"scim:group:{display_name}")
        for uid in touched:
            _reconcile_user_role(uid, request=request)
        return _scim_resp(_scim_group(row, location_base=_scim_base(request),
                                     member_resolver=scim_user_store.get))

    @app.patch("/scim/v2/Groups/{group_id}", include_in_schema=False,
               dependencies=[Depends(_require_scim)])
    async def scim_patch_group(group_id: str, request: _ScimReq):
        existing = scim_group_store.get(group_id)
        if not existing:
            return _scim_resp(_scim_error("Group not found", 404), 404)
        try:
            payload = await request.json()
        except Exception:
            return _scim_resp(_scim_error("body must be JSON", 400, "invalidSyntax"), 400)
        if not isinstance(payload, dict):
            return _scim_resp(_scim_error("body must be a JSON object", 400, "invalidSyntax"), 400)
        changes = _scim_group_patch(payload)
        touched: set[str] = set()
        prior_role = existing.role
        # 1. attribute updates
        attr_changes: dict = {}
        for k in ("display_name", "external_id"):
            if k in changes and changes[k] is not None:
                attr_changes[k] = changes[k]
        # role may arrive via urn extension at top level, not via patch ops
        if "role" in changes and isinstance(changes["role"], str):
            cand = str(changes["role"]).lower()
            if cand in _ROLES:
                attr_changes["role"] = cand
        # 2. membership changes
        if "replace_members" in changes:
            new_members: list[str] = []
            for uid in changes["replace_members"]:
                if scim_user_store.get(uid) is not None:
                    new_members.append(uid)
            touched |= set(existing.members) | set(new_members)
            attr_changes["members"] = new_members
        else:
            current = list(existing.members)
            for uid in changes.get("add_members", []):
                if scim_user_store.get(uid) is not None and uid not in current:
                    current.append(uid)
                    touched.add(uid)
            for uid in changes.get("remove_members", []):
                if uid in current:
                    current = [m for m in current if m != uid]
                    touched.add(uid)
            attr_changes["members"] = current
        row = scim_group_store.replace(group_id, **attr_changes)
        new_role = row.role if row is not None else existing.role
        if new_role != prior_role:
            # role flipped, every current member needs reconciliation
            touched |= set(row.members if row is not None else existing.members)
        _scim_audit(request, "scim.group.patch", 200, {
            "group_id": group_id,
            "add": changes.get("add_members", []),
            "remove": changes.get("remove_members", []),
            "replace": changes.get("replace_members"),
            "attrs": {k: v for k, v in attr_changes.items() if k != "members"},
            "role_changed": new_role != prior_role,
        }, label=f"scim:group:{existing.display_name}")
        for uid in touched:
            _reconcile_user_role(uid, request=request)
        return _scim_resp(_scim_group(row, location_base=_scim_base(request),
                                     member_resolver=scim_user_store.get))

    @app.delete("/scim/v2/Groups/{group_id}", include_in_schema=False,
                dependencies=[Depends(_require_scim)])
    def scim_delete_group(group_id: str, request: _ScimReq):
        existing = scim_group_store.get(group_id)
        if not existing:
            return _scim_resp(_scim_error("Group not found", 404), 404)
        members_snapshot = list(existing.members)
        scim_group_store.delete(group_id)
        _scim_audit(request, "scim.group.delete", 204, {
            "group_id": group_id, "display_name": existing.display_name,
            "members": members_snapshot, "role": existing.role,
        }, label=f"scim:group:{existing.display_name}")
        for uid in members_snapshot:
            _reconcile_user_role(uid, request=request)
        from fastapi.responses import Response as _NCResp
        return _NCResp(status_code=204)

    # ---------- admin surface: configure / rotate / disable bearer ----------

    @app.get("/admin/scim",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_get():
        return scim_cfg_store.get().to_public()

    @app.post("/admin/scim/rotate",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_rotate(request: _ScimReq):
        cfg, bearer = scim_cfg_store.rotate_bearer()
        _scim_audit(request, "scim.bearer.rotate", 200, {}, label="admin")
        out = cfg.to_public()
        out["bearer"] = bearer
        out["note"] = "Store this bearer now. It will not be shown again."
        return out

    @app.post("/admin/scim/disable",
              dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_disable(request: _ScimReq):
        cfg = scim_cfg_store.disable()
        _scim_audit(request, "scim.bearer.disable", 200, {}, label="admin")
        return cfg.to_public()

    @app.put("/admin/scim/policy",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_policy(body: dict, request: _ScimReq):
        role = str(body.get("default_role") or "member").strip().lower()
        if role not in _ROLES:
            raise HTTPException(400, f"default_role must be one of {sorted(_ROLES)}")
        scopes_in = body.get("default_scopes") or ["read"]
        if not isinstance(scopes_in, list) or not all(isinstance(s, str) for s in scopes_in):
            raise HTTPException(400, "default_scopes must be a list of strings")
        allowed = _ROLE_SCOPES[role]
        scopes = sorted({s for s in scopes_in if s in allowed}) or ["read"]
        cfg = scim_cfg_store.set_policy(role, scopes)
        _scim_audit(request, "scim.policy.update", 200, {
            "default_role": role, "default_scopes": scopes,
        }, label="admin")
        return cfg.to_public()

    @app.get("/admin/scim/users",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_users():
        return {
            "users": [
                {
                    "id": u.id, "user_name": u.user_name,
                    "external_id": u.external_id, "display_name": u.display_name,
                    "email": u.email, "active": u.active, "key_id": u.key_id,
                    "created_at": u.created_at, "updated_at": u.updated_at,
                    "groups": [
                        {"id": g.id, "display_name": g.display_name, "role": g.role}
                        for g in scim_group_store.groups_for_user(u.id)
                    ],
                }
                for u in scim_user_store.list()
            ]
        }

    @app.get("/admin/scim/groups",
             dependencies=[Depends(require_scope("admin")), Depends(require_mfa_for_admin)])
    def admin_scim_groups():
        return {
            "groups": [
                {
                    "id": g.id,
                    "display_name": g.display_name,
                    "external_id": g.external_id,
                    "role": g.role,
                    "member_count": len(g.members),
                    "members": [
                        {
                            "user_id": uid,
                            "user_name": (scim_user_store.get(uid).user_name
                                          if scim_user_store.get(uid) else uid),
                        }
                        for uid in g.members
                    ],
                    "created_at": g.created_at,
                    "updated_at": g.updated_at,
                }
                for g in scim_group_store.list()
            ]
        }

    return app


app = create_app()
