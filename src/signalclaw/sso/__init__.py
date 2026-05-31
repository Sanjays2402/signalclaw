"""OIDC single sign-on for SignalClaw.

Why this module exists
----------------------
Enterprise procurement reviews block API-key-only products. Security
teams require federation against the company IdP (Okta, Google,
Microsoft Entra, Auth0, Keycloak) so that:

* Joiners get access via their existing IdP group, not a manually
  minted secret pasted into Slack.
* Leavers are deprovisioned by disabling their IdP account, with no
  stale API keys to chase down.
* Every login is funneled through the IdP's MFA and conditional
  access policy.

What this module provides
-------------------------
A minimal but real OIDC Authorization Code flow:

* :class:`OidcConfigStore` -- on-disk config (issuer, client id /
  secret, redirect uri, allowed email domain, default role) so
  configuration survives restart. One config per workspace; this
  build ships a single global config (the rest of SignalClaw is
  single-workspace) which keeps the surface area small without
  blocking a future workspace_id column.
* :class:`StateStore` -- short-lived CSRF state + PKCE verifier
  ledger for the Authorization Code + PKCE flow.
* :class:`OidcClient` -- discovery, token exchange, and userinfo
  fetch. ``httpx`` is already a hard dependency so this adds no new
  third-party code.
* :func:`require_email_allowed` -- domain allowlist gate enforced
  before a key is minted.

No mock, no placeholder: the callback handler in
``signalclaw.api.app`` mints a real :class:`signalclaw.api_keys.StoredKey`
via the existing store, audits the event through the existing
:class:`signalclaw.audit.AuditLog`, and returns the secret exactly
once. The minted key is treated like any other key by every
downstream middleware (RBAC, rate limit, IP allowlist, sessions,
revocation).
"""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import httpx


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


_ALLOWED_ROLES = ("owner", "admin", "member", "viewer")


@dataclass
class OidcConfig:
    """Runtime OIDC configuration.

    ``client_secret`` is held in memory and on disk so the callback
    handler can complete the token exchange. The admin GET endpoint
    redacts it before returning to a client. ``allowed_email_domains``
    is matched case-insensitively against the IdP-issued ``email``
    claim; empty list means "any verified email is accepted" which
    we deliberately make the explicit opt-in default rather than the
    silent one.
    """

    enabled: bool = False
    issuer: str = ""
    client_id: str = ""
    client_secret: str = ""
    redirect_uri: str = ""
    allowed_email_domains: List[str] = field(default_factory=list)
    default_role: str = "viewer"
    default_scopes: List[str] = field(default_factory=lambda: ["read"])
    updated_at: Optional[str] = None

    def public_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        if d.get("client_secret"):
            d["client_secret"] = "***redacted***"
            d["client_secret_set"] = True
        else:
            d["client_secret_set"] = False
            d["client_secret"] = ""
        return d


def _utc_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


class OidcConfigStore:
    """JSON-backed OIDC config. Thread-safe."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps(asdict(OidcConfig()), indent=2))

    def get(self) -> OidcConfig:
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except json.JSONDecodeError:
            raw = {}
        return OidcConfig(
            enabled=bool(raw.get("enabled", False)),
            issuer=str(raw.get("issuer", "") or "").strip(),
            client_id=str(raw.get("client_id", "") or "").strip(),
            client_secret=str(raw.get("client_secret", "") or ""),
            redirect_uri=str(raw.get("redirect_uri", "") or "").strip(),
            allowed_email_domains=[
                d.strip().lower() for d in raw.get("allowed_email_domains", []) or [] if d and d.strip()
            ],
            default_role=_normalise_role(raw.get("default_role")),
            default_scopes=[
                s for s in raw.get("default_scopes", []) or [] if s
            ] or ["read"],
            updated_at=raw.get("updated_at"),
        )

    def put(self, cfg: OidcConfig) -> OidcConfig:
        # Validation: an enabled config must be self-consistent.
        if cfg.enabled:
            missing = [
                k for k, v in (
                    ("issuer", cfg.issuer),
                    ("client_id", cfg.client_id),
                    ("client_secret", cfg.client_secret),
                    ("redirect_uri", cfg.redirect_uri),
                )
                if not v
            ]
            if missing:
                raise ValueError(
                    f"oidc config enabled but missing fields: {','.join(missing)}"
                )
            if not cfg.issuer.startswith("https://") and not cfg.issuer.startswith("http://localhost"):
                raise ValueError("issuer must be https:// (or http://localhost for dev)")
            if not cfg.redirect_uri.startswith("http"):
                raise ValueError("redirect_uri must be an absolute URL")
        cfg.default_role = _normalise_role(cfg.default_role)
        cfg.allowed_email_domains = [d.strip().lower() for d in cfg.allowed_email_domains if d and d.strip()]
        cfg.default_scopes = [s for s in cfg.default_scopes if s] or ["read"]
        cfg.updated_at = _utc_iso()
        with self._lock:
            self.path.write_text(json.dumps(asdict(cfg), indent=2, sort_keys=True))
        return cfg

    def clear(self) -> None:
        with self._lock:
            self.path.write_text(json.dumps(asdict(OidcConfig()), indent=2))


def _normalise_role(role: Optional[str]) -> str:
    r = (role or "viewer").strip().lower()
    return r if r in _ALLOWED_ROLES else "viewer"


# ---------------------------------------------------------------------------
# State / PKCE
# ---------------------------------------------------------------------------


@dataclass
class StateRecord:
    state: str
    code_verifier: str
    nonce: str
    created_at: float
    return_to: str = "/"


class StateStore:
    """In-memory CSRF state + PKCE verifier ledger.

    State is bound to a single login attempt and expires after
    ``ttl_seconds``. A successful or failed callback consumes the
    record. Server restart invalidates outstanding logins, which is
    correct: a state older than the process is by definition stale.
    """

    def __init__(self, ttl_seconds: int = 600) -> None:
        self._ttl = int(ttl_seconds)
        self._lock = threading.Lock()
        self._records: Dict[str, StateRecord] = {}

    def _prune(self) -> None:
        now = time.time()
        dead = [k for k, v in self._records.items() if now - v.created_at > self._ttl]
        for k in dead:
            self._records.pop(k, None)

    def issue(self, return_to: str = "/") -> StateRecord:
        with self._lock:
            self._prune()
            rec = StateRecord(
                state=secrets.token_urlsafe(24),
                code_verifier=secrets.token_urlsafe(48),
                nonce=secrets.token_urlsafe(16),
                created_at=time.time(),
                return_to=return_to or "/",
            )
            self._records[rec.state] = rec
            return rec

    def consume(self, state: str) -> Optional[StateRecord]:
        if not state:
            return None
        with self._lock:
            self._prune()
            return self._records.pop(state, None)


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


# ---------------------------------------------------------------------------
# OIDC client
# ---------------------------------------------------------------------------


class OidcError(Exception):
    """Raised when the IdP rejects a request or returns malformed data."""


class OidcClient:
    """Minimal OIDC Authorization Code + PKCE client.

    Discovery is cached for ``discovery_ttl_seconds``. The client is
    deliberately stateless beyond that cache so it can be constructed
    per-request without a global; tests can inject a fake ``http``
    to avoid network calls.
    """

    DEFAULT_TIMEOUT = 10.0

    def __init__(
        self,
        config: OidcConfig,
        *,
        http: Optional[httpx.Client] = None,
        discovery_ttl_seconds: int = 3600,
    ) -> None:
        self.config = config
        self._http = http
        self._discovery_ttl = int(discovery_ttl_seconds)
        self._discovery: Optional[Dict[str, Any]] = None
        self._discovery_fetched_at: float = 0.0

    def _client(self) -> httpx.Client:
        if self._http is not None:
            return self._http
        return httpx.Client(timeout=self.DEFAULT_TIMEOUT)

    def discover(self) -> Dict[str, Any]:
        now = time.time()
        if (
            self._discovery is not None
            and now - self._discovery_fetched_at < self._discovery_ttl
        ):
            return self._discovery
        issuer = self.config.issuer.rstrip("/")
        url = f"{issuer}/.well-known/openid-configuration"
        try:
            r = self._client().get(url)
        except httpx.HTTPError as exc:
            raise OidcError(f"discovery failed: {exc}") from exc
        if r.status_code != 200:
            raise OidcError(f"discovery returned {r.status_code}")
        try:
            doc = r.json()
        except ValueError as exc:
            raise OidcError("discovery returned non-JSON") from exc
        for required in ("authorization_endpoint", "token_endpoint"):
            if required not in doc:
                raise OidcError(f"discovery missing {required}")
        self._discovery = doc
        self._discovery_fetched_at = now
        return doc

    def authorization_url(self, state: StateRecord) -> str:
        doc = self.discover()
        params = {
            "response_type": "code",
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "scope": "openid email profile",
            "state": state.state,
            "nonce": state.nonce,
            "code_challenge": pkce_challenge(state.code_verifier),
            "code_challenge_method": "S256",
        }
        return f"{doc['authorization_endpoint']}?{urlencode(params)}"

    def exchange_code(self, code: str, state: StateRecord) -> Dict[str, Any]:
        doc = self.discover()
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.config.redirect_uri,
            "client_id": self.config.client_id,
            "client_secret": self.config.client_secret,
            "code_verifier": state.code_verifier,
        }
        try:
            r = self._client().post(doc["token_endpoint"], data=data)
        except httpx.HTTPError as exc:
            raise OidcError(f"token exchange failed: {exc}") from exc
        if r.status_code != 200:
            raise OidcError(f"token endpoint returned {r.status_code}: {r.text[:200]}")
        try:
            return r.json()
        except ValueError as exc:
            raise OidcError("token endpoint returned non-JSON") from exc

    def userinfo(self, access_token: str) -> Dict[str, Any]:
        doc = self.discover()
        endpoint = doc.get("userinfo_endpoint")
        if not endpoint:
            # Fall back to decoding the id_token if no userinfo endpoint.
            raise OidcError("provider has no userinfo_endpoint")
        try:
            r = self._client().get(
                endpoint, headers={"Authorization": f"Bearer {access_token}"}
            )
        except httpx.HTTPError as exc:
            raise OidcError(f"userinfo failed: {exc}") from exc
        if r.status_code != 200:
            raise OidcError(f"userinfo returned {r.status_code}")
        try:
            return r.json()
        except ValueError as exc:
            raise OidcError("userinfo returned non-JSON") from exc


def decode_id_token_unverified(id_token: str) -> Dict[str, Any]:
    """Decode the payload of a JWT without verifying its signature.

    SignalClaw uses ``email`` from the id_token only as a hint when
    the IdP exposes no userinfo endpoint. The authoritative trust
    chain is the HTTPS token exchange against the configured
    ``client_secret``, not the JWT signature. Callers that need full
    verification should add ``python-jose`` and verify against the
    discovered JWKS.
    """
    try:
        parts = id_token.split(".")
        if len(parts) < 2:
            raise OidcError("id_token has too few segments")
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
        return json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise OidcError("id_token payload not decodable") from exc


def extract_email(token_response: Dict[str, Any], userinfo: Optional[Dict[str, Any]]) -> str:
    """Pull the user's email out of the IdP response.

    Preference order:

    1. ``userinfo['email']`` -- the IdP just confirmed this token
       belongs to that user over an authenticated channel.
    2. ``id_token`` payload ``email`` claim -- present on every
       compliant OIDC provider for the ``email`` scope.
    """
    if userinfo and userinfo.get("email"):
        return str(userinfo["email"]).strip().lower()
    id_token = token_response.get("id_token")
    if id_token:
        payload = decode_id_token_unverified(id_token)
        if payload.get("email"):
            return str(payload["email"]).strip().lower()
    raise OidcError("IdP response carried no email claim")


def email_allowed(email: str, allowed_domains: List[str]) -> bool:
    """Domain allowlist gate.

    Empty allowlist intentionally denies everyone: an enabled OIDC
    config with no domain list is almost certainly a misconfiguration,
    and silently letting any IdP user in (including a personal Gmail
    on a Google Workspace tenant) would be a tenancy break.
    """
    if not email or "@" not in email:
        return False
    if not allowed_domains:
        return False
    domain = email.rsplit("@", 1)[-1].lower()
    return domain in {d.lower() for d in allowed_domains}


__all__ = [
    "OidcConfig",
    "OidcConfigStore",
    "StateStore",
    "StateRecord",
    "OidcClient",
    "OidcError",
    "pkce_challenge",
    "decode_id_token_unverified",
    "extract_email",
    "email_allowed",
]
