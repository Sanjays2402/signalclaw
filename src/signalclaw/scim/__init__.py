"""SCIM 2.0 user provisioning for SignalClaw.

Why this module exists
----------------------
Enterprise procurement reviewers require automated joiner / mover /
leaver provisioning that does not depend on a human pasting secrets
into Slack. The de-facto standard is SCIM 2.0 (RFC 7643/7644), which
Okta, Microsoft Entra ID, Google Workspace, OneLogin and JumpCloud
all speak. With SCIM in place a security team can:

* Provision a new hire by adding them to an IdP group; SignalClaw
  mints an API key automatically and returns it to the IdP for
  out-of-band delivery (or the IdP-side connector treats the key
  as opaque and the hire requests one via SSO instead).
* Deprovision a leaver by disabling their IdP account; SignalClaw
  revokes the bound API key within seconds, with no stale credentials
  to chase down.
* Reconcile drift on demand with a SCIM list call from the IdP.

What this module provides
-------------------------
A minimal-but-real SCIM 2.0 ``/Users`` implementation:

* :class:`ScimConfigStore` -- on-disk bearer token plus default role /
  scope policy. Provisioning is gated by ``Authorization: Bearer ...``
  using a constant-time compare. Bearer is rotatable.
* :class:`ScimUserStore` -- 1:1 mapping between a SCIM ``User``
  resource (with ``id``, ``externalId``, ``userName``, ``active``,
  ``displayName``, ``emails``) and a SignalClaw :class:`StoredKey`.
  Persisted as JSON next to the api-key store so a restart preserves
  the binding.
* :func:`build_scim_user` -- shape a SignalClaw record into a
  SCIM-compliant ``User`` JSON document (schemas, meta, id,
  ``userName``, ``active``).

No mock, no placeholder: the routes in ``signalclaw.api.app`` call
``ApiKeyStore.create`` / ``revoke`` directly, and every mutation is
written to the existing :class:`signalclaw.audit.AuditLog` with the
SCIM resource id and the IdP-supplied externalId so a reviewer can
trace a deprovision back to the source-of-truth ticket.
"""
from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"
SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error"
SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
SCIM_SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"
SCIM_RT_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType"


# ---------------------------------------------------------------------------
# Config store: bearer token + default role
# ---------------------------------------------------------------------------


@dataclass
class ScimConfig:
    enabled: bool = False
    bearer_hash: str = ""  # sha256 hex of the bearer; empty => disabled
    default_role: str = "member"
    default_scopes: List[str] = field(default_factory=lambda: ["read"])
    updated_at: str = ""

    def to_public(self) -> Dict[str, Any]:
        # Never leak the bearer hash to the admin UI.
        return {
            "enabled": self.enabled,
            "bearer_configured": bool(self.bearer_hash),
            "default_role": self.default_role,
            "default_scopes": list(self.default_scopes),
            "updated_at": self.updated_at,
        }


def _sha256_hex(s: str) -> str:
    import hashlib
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ScimConfigStore:
    """On-disk SCIM provisioning config. One row, one file."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _read(self) -> ScimConfig:
        if not self.path.exists():
            return ScimConfig()
        try:
            data = json.loads(self.path.read_text() or "{}")
        except Exception:
            return ScimConfig()
        return ScimConfig(
            enabled=bool(data.get("enabled", False)),
            bearer_hash=str(data.get("bearer_hash", "")),
            default_role=str(data.get("default_role", "member")),
            default_scopes=list(data.get("default_scopes", ["read"])),
            updated_at=str(data.get("updated_at", "")),
        )

    def get(self) -> ScimConfig:
        return self._read()

    def set_policy(self, default_role: str, default_scopes: List[str]) -> ScimConfig:
        with self._lock:
            cfg = self._read()
            cfg.default_role = default_role
            cfg.default_scopes = list(default_scopes)
            cfg.updated_at = _now_iso()
            self._write(cfg)
            return cfg

    def rotate_bearer(self) -> Tuple[ScimConfig, str]:
        """Mint a new bearer token. Returns (config, plaintext_bearer).

        The plaintext is returned exactly once. Subsequent reads only
        ever see the sha256 hash.
        """
        bearer = "scim_" + secrets.token_urlsafe(32)
        with self._lock:
            cfg = self._read()
            cfg.bearer_hash = _sha256_hex(bearer)
            cfg.enabled = True
            cfg.updated_at = _now_iso()
            self._write(cfg)
            return cfg, bearer

    def disable(self) -> ScimConfig:
        with self._lock:
            cfg = self._read()
            cfg.enabled = False
            cfg.bearer_hash = ""
            cfg.updated_at = _now_iso()
            self._write(cfg)
            return cfg

    def _write(self, cfg: ScimConfig) -> None:
        self.path.write_text(json.dumps(asdict(cfg), indent=2, sort_keys=True))

    def verify_bearer(self, presented: str) -> bool:
        cfg = self._read()
        if not cfg.enabled or not cfg.bearer_hash:
            return False
        if not isinstance(presented, str) or not presented:
            return False
        return hmac.compare_digest(_sha256_hex(presented), cfg.bearer_hash)


# ---------------------------------------------------------------------------
# User store: SCIM resource <-> SignalClaw key id
# ---------------------------------------------------------------------------


@dataclass
class ScimUser:
    id: str
    external_id: str
    user_name: str
    display_name: str
    email: str
    active: bool
    key_id: str
    created_at: str
    updated_at: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ScimUserStore:
    """Persistent SCIM user -> StoredKey mapping (JSON file)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _read(self) -> List[ScimUser]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except Exception:
            return []
        out: List[ScimUser] = []
        for row in raw.get("users", []):
            try:
                out.append(ScimUser(**row))
            except Exception:
                continue
        return out

    def _write(self, rows: List[ScimUser]) -> None:
        self.path.write_text(json.dumps(
            {"users": [u.to_dict() for u in rows]}, indent=2, sort_keys=True))

    def list(self, filter_username: Optional[str] = None) -> List[ScimUser]:
        rows = self._read()
        if filter_username:
            uname = filter_username.lower()
            rows = [u for u in rows if u.user_name.lower() == uname]
        return rows

    def get(self, user_id: str) -> Optional[ScimUser]:
        for u in self._read():
            if u.id == user_id:
                return u
        return None

    def get_by_username(self, user_name: str) -> Optional[ScimUser]:
        uname = (user_name or "").lower()
        for u in self._read():
            if u.user_name.lower() == uname:
                return u
        return None

    def create(
        self,
        *,
        user_name: str,
        external_id: str,
        display_name: str,
        email: str,
        active: bool,
        key_id: str,
    ) -> ScimUser:
        with self._lock:
            rows = self._read()
            if any(r.user_name.lower() == user_name.lower() for r in rows):
                raise ValueError("userName already exists")
            now = _now_iso()
            row = ScimUser(
                id=secrets.token_hex(8),
                external_id=external_id or "",
                user_name=user_name,
                display_name=display_name or user_name,
                email=email or user_name,
                active=bool(active),
                key_id=key_id,
                created_at=now,
                updated_at=now,
            )
            rows.append(row)
            self._write(rows)
            return row

    def replace(self, user_id: str, **fields: Any) -> Optional[ScimUser]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == user_id:
                    for k in ("user_name", "external_id", "display_name", "email"):
                        if k in fields and fields[k] is not None:
                            setattr(r, k, str(fields[k]))
                    if "active" in fields and fields["active"] is not None:
                        r.active = bool(fields["active"])
                    if "key_id" in fields and fields["key_id"]:
                        r.key_id = str(fields["key_id"])
                    r.updated_at = _now_iso()
                    rows[i] = r
                    self._write(rows)
                    return r
            return None

    def set_active(self, user_id: str, active: bool) -> Optional[ScimUser]:
        return self.replace(user_id, active=active)

    def delete(self, user_id: str) -> Optional[ScimUser]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == user_id:
                    del rows[i]
                    self._write(rows)
                    return r
            return None


# ---------------------------------------------------------------------------
# SCIM JSON shaping
# ---------------------------------------------------------------------------


def build_scim_user(u: ScimUser, *, location_base: str) -> Dict[str, Any]:
    """Render a :class:`ScimUser` as a SCIM 2.0 ``User`` resource."""
    return {
        "schemas": [SCIM_USER_SCHEMA],
        "id": u.id,
        "externalId": u.external_id or None,
        "userName": u.user_name,
        "displayName": u.display_name,
        "active": bool(u.active),
        "emails": [
            {"value": u.email, "primary": True, "type": "work"}
        ] if u.email else [],
        "meta": {
            "resourceType": "User",
            "created": u.created_at,
            "lastModified": u.updated_at,
            "location": f"{location_base.rstrip('/')}/Users/{u.id}",
            "version": f'W/"{u.updated_at}"',
        },
    }


def scim_error(detail: str, status: int, scim_type: Optional[str] = None) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "schemas": [SCIM_ERROR_SCHEMA],
        "detail": detail,
        "status": str(status),
    }
    if scim_type:
        body["scimType"] = scim_type
    return body


# ---------------------------------------------------------------------------
# Group store: SCIM Group <-> role mapping with members
# ---------------------------------------------------------------------------


@dataclass
class ScimGroup:
    """A SCIM Group bound to a SignalClaw role.

    Members are SCIM user ids (``ScimUser.id``). Group membership is
    the authoritative source for the bound api key's role: when a user
    is added to a group with ``role='admin'``, their key is promoted;
    when removed, the highest remaining group role wins, falling back
    to the SCIM default role.
    """

    id: str
    display_name: str
    external_id: str
    role: str  # signalclaw role to grant to members
    members: List[str] = field(default_factory=list)  # SCIM user ids
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class ScimGroupStore:
    """Persistent SCIM group store (JSON file)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _read(self) -> List[ScimGroup]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text() or "{}")
        except Exception:
            return []
        out: List[ScimGroup] = []
        for row in raw.get("groups", []):
            try:
                out.append(ScimGroup(
                    id=str(row["id"]),
                    display_name=str(row.get("display_name", "")),
                    external_id=str(row.get("external_id", "")),
                    role=str(row.get("role", "member")),
                    members=list(row.get("members", [])),
                    created_at=str(row.get("created_at", "")),
                    updated_at=str(row.get("updated_at", "")),
                ))
            except Exception:
                continue
        return out

    def _write(self, rows: List[ScimGroup]) -> None:
        self.path.write_text(json.dumps(
            {"groups": [g.to_dict() for g in rows]}, indent=2, sort_keys=True))

    def list(self, filter_display_name: Optional[str] = None) -> List[ScimGroup]:
        rows = self._read()
        if filter_display_name:
            d = filter_display_name.lower()
            rows = [g for g in rows if g.display_name.lower() == d]
        return rows

    def get(self, group_id: str) -> Optional[ScimGroup]:
        for g in self._read():
            if g.id == group_id:
                return g
        return None

    def get_by_display_name(self, display_name: str) -> Optional[ScimGroup]:
        d = (display_name or "").lower()
        for g in self._read():
            if g.display_name.lower() == d:
                return g
        return None

    def create(self, *, display_name: str, external_id: str, role: str,
               members: Optional[List[str]] = None) -> ScimGroup:
        with self._lock:
            rows = self._read()
            if any(r.display_name.lower() == display_name.lower() for r in rows):
                raise ValueError("displayName already exists")
            now = _now_iso()
            row = ScimGroup(
                id=secrets.token_hex(8),
                display_name=display_name,
                external_id=external_id or "",
                role=role,
                members=list(members or []),
                created_at=now,
                updated_at=now,
            )
            rows.append(row)
            self._write(rows)
            return row

    def replace(self, group_id: str, **fields: Any) -> Optional[ScimGroup]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == group_id:
                    for k in ("display_name", "external_id", "role"):
                        if k in fields and fields[k] is not None:
                            setattr(r, k, str(fields[k]))
                    if "members" in fields and fields["members"] is not None:
                        # dedupe, preserve order
                        seen: set = set()
                        cleaned: List[str] = []
                        for m in fields["members"]:
                            if m and m not in seen:
                                seen.add(m)
                                cleaned.append(str(m))
                        r.members = cleaned
                    r.updated_at = _now_iso()
                    rows[i] = r
                    self._write(rows)
                    return r
            return None

    def add_member(self, group_id: str, user_id: str) -> Optional[ScimGroup]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == group_id:
                    if user_id not in r.members:
                        r.members.append(user_id)
                        r.updated_at = _now_iso()
                        rows[i] = r
                        self._write(rows)
                    return r
            return None

    def remove_member(self, group_id: str, user_id: str) -> Optional[ScimGroup]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == group_id:
                    if user_id in r.members:
                        r.members = [m for m in r.members if m != user_id]
                        r.updated_at = _now_iso()
                        rows[i] = r
                        self._write(rows)
                    return r
            return None

    def delete(self, group_id: str) -> Optional[ScimGroup]:
        with self._lock:
            rows = self._read()
            for i, r in enumerate(rows):
                if r.id == group_id:
                    del rows[i]
                    self._write(rows)
                    return r
            return None

    def groups_for_user(self, user_id: str) -> List[ScimGroup]:
        return [g for g in self._read() if user_id in g.members]


def build_scim_group(g: ScimGroup, *, location_base: str,
                     member_resolver=None) -> Dict[str, Any]:
    """Render a :class:`ScimGroup` as a SCIM 2.0 ``Group`` resource.

    ``member_resolver`` is an optional callable ``(user_id) -> ScimUser``
    used to fill the ``display`` field on each member entry. Missing
    users are still included by id so deprovisioning races do not crash
    the IdP reconciliation pass.
    """
    members: List[Dict[str, Any]] = []
    for uid in g.members:
        entry: Dict[str, Any] = {
            "value": uid,
            "$ref": f"{location_base.rstrip('/')}/Users/{uid}",
            "type": "User",
        }
        if member_resolver is not None:
            try:
                u = member_resolver(uid)
            except Exception:
                u = None
            if u is not None:
                entry["display"] = getattr(u, "display_name", "") or getattr(u, "user_name", "")
        members.append(entry)
    return {
        "schemas": [SCIM_GROUP_SCHEMA],
        "id": g.id,
        "externalId": g.external_id or None,
        "displayName": g.display_name,
        "members": members,
        "urn:signalclaw:scim:extension:1.0": {"role": g.role},
        "meta": {
            "resourceType": "Group",
            "created": g.created_at,
            "lastModified": g.updated_at,
            "location": f"{location_base.rstrip('/')}/Groups/{g.id}",
            "version": f'W/"{g.updated_at}"',
        },
    }


def apply_group_patch_ops(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate a SCIM Group PatchOp body.

    Returns a dict with keys:
        * ``display_name`` / ``external_id`` / ``role`` (replace)
        * ``add_members`` / ``remove_members`` (lists of user ids)
        * ``replace_members`` (list of user ids, if a full replace)

    Supports the operations Okta / Entra send for group membership:
        * ``add`` ``path=members`` ``value=[{"value": uid}, ...]``
        * ``remove`` ``path=members[value eq "uid"]``
        * ``remove`` ``path=members`` ``value=[{"value": uid}]``
        * ``replace`` ``path=members`` ``value=[...]``
        * ``replace`` simple attrs (displayName, externalId)
    """
    out: Dict[str, Any] = {
        "add_members": [],
        "remove_members": [],
    }
    ops = payload.get("Operations") or payload.get("operations") or []
    if not isinstance(ops, list):
        return out
    for op in ops:
        if not isinstance(op, dict):
            continue
        verb = str(op.get("op") or "").lower()
        path = op.get("path")
        value = op.get("value")
        path_str = path if isinstance(path, str) else ""
        path_key = path_str.split("[", 1)[0].split(".", 1)[0].strip()
        # members add / remove / replace
        if path_key == "members":
            if verb == "remove":
                # remove can carry an inline filter members[value eq "x"]
                if "[" in path_str and "value eq" in path_str.lower():
                    rhs = path_str.split("value eq", 1)[1]
                    rhs = rhs.strip().rstrip("]").strip()
                    if rhs.startswith('"') and rhs.endswith('"'):
                        out["remove_members"].append(rhs[1:-1])
                elif isinstance(value, list):
                    for v in value:
                        if isinstance(v, dict) and isinstance(v.get("value"), str):
                            out["remove_members"].append(v["value"])
                        elif isinstance(v, str):
                            out["remove_members"].append(v)
                continue
            if verb == "add" and isinstance(value, list):
                for v in value:
                    if isinstance(v, dict) and isinstance(v.get("value"), str):
                        out["add_members"].append(v["value"])
                    elif isinstance(v, str):
                        out["add_members"].append(v)
                continue
            if verb == "replace" and isinstance(value, list):
                rep: List[str] = []
                for v in value:
                    if isinstance(v, dict) and isinstance(v.get("value"), str):
                        rep.append(v["value"])
                    elif isinstance(v, str):
                        rep.append(v)
                out["replace_members"] = rep
                continue
        # simple attribute replace
        if verb in ("replace", "add"):
            if path_key in ("displayName", "externalId"):
                out[_snake(path_key) if path_key != "displayName" else "display_name"] = value
            elif isinstance(value, dict):
                for k, v in value.items():
                    if k in ("displayName", "externalId"):
                        out["display_name" if k == "displayName" else "external_id"] = v
                    elif k == "members" and isinstance(v, list):
                        rep2: List[str] = []
                        for m in v:
                            if isinstance(m, dict) and isinstance(m.get("value"), str):
                                rep2.append(m["value"])
                            elif isinstance(m, str):
                                rep2.append(m)
                        out["replace_members"] = rep2
    return out


def service_provider_config() -> Dict[str, Any]:
    return {
        "schemas": [SCIM_SPC_SCHEMA],
        "documentationUri": "https://github.com/Sanjays2402/signalclaw/blob/main/SECURITY.md",
        "patch": {"supported": True},
        "bulk": {"supported": False, "maxOperations": 0, "maxPayloadSize": 0},
        "filter": {"supported": True, "maxResults": 200},
        "changePassword": {"supported": False},
        "sort": {"supported": False},
        "etag": {"supported": False},
        "authenticationSchemes": [
            {
                "type": "oauthbearertoken",
                "name": "OAuth Bearer Token",
                "description": "Authentication via a SignalClaw-minted SCIM bearer token.",
                "primary": True,
            }
        ],
        "meta": {"resourceType": "ServiceProviderConfig", "location": "/scim/v2/ServiceProviderConfig"},
    }


def resource_types() -> Dict[str, Any]:
    return {
        "schemas": [SCIM_LIST_SCHEMA],
        "totalResults": 2,
        "Resources": [
            {
                "schemas": [SCIM_RT_SCHEMA],
                "id": "User",
                "name": "User",
                "endpoint": "/Users",
                "description": "SignalClaw API key holder",
                "schema": SCIM_USER_SCHEMA,
                "meta": {"resourceType": "ResourceType", "location": "/scim/v2/ResourceTypes/User"},
            },
            {
                "schemas": [SCIM_RT_SCHEMA],
                "id": "Group",
                "name": "Group",
                "endpoint": "/Groups",
                "description": "SignalClaw role binding for SCIM users",
                "schema": SCIM_GROUP_SCHEMA,
                "meta": {"resourceType": "ResourceType", "location": "/scim/v2/ResourceTypes/Group"},
            },
        ],
    }


def parse_userName(payload: Dict[str, Any]) -> Optional[str]:
    """Accept ``userName`` (SCIM) or fall back to first email."""
    u = payload.get("userName")
    if isinstance(u, str) and u.strip():
        return u.strip()
    emails = payload.get("emails")
    if isinstance(emails, list):
        for e in emails:
            if isinstance(e, dict) and isinstance(e.get("value"), str):
                return e["value"].strip()
    return None


def parse_primary_email(payload: Dict[str, Any]) -> str:
    emails = payload.get("emails")
    if isinstance(emails, list):
        for e in emails:
            if isinstance(e, dict) and e.get("primary") and isinstance(e.get("value"), str):
                return e["value"].strip()
        for e in emails:
            if isinstance(e, dict) and isinstance(e.get("value"), str):
                return e["value"].strip()
    u = payload.get("userName")
    return u.strip() if isinstance(u, str) else ""


def apply_patch_ops(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Translate a SCIM PatchOp body into a flat dict of fields to set.

    Supports the operations Okta and Entra actually send:
    * ``replace`` ``{"active": false}`` (deactivate)
    * ``replace`` ``{"displayName": "..."}`` etc
    * ``replace`` with path ``active`` / ``displayName`` / ``userName`` /
      ``externalId``
    Unknown ops are ignored (best-effort, never 500).
    """
    out: Dict[str, Any] = {}
    ops = payload.get("Operations") or payload.get("operations") or []
    if not isinstance(ops, list):
        return out
    for op in ops:
        if not isinstance(op, dict):
            continue
        verb = str(op.get("op") or "").lower()
        if verb not in ("replace", "add"):
            continue
        path = op.get("path")
        value = op.get("value")
        if path and isinstance(path, str):
            key = path.strip()
            # strip filter syntax like emails[type eq "work"].value
            key = key.split("[", 1)[0].split(".", 1)[0]
            if key == "active":
                out["active"] = bool(value) if not isinstance(value, str) else (value.lower() == "true")
            elif key in ("displayName", "userName", "externalId"):
                out[_snake(key)] = value
        elif isinstance(value, dict):
            for k, v in value.items():
                if k == "active":
                    out["active"] = bool(v) if not isinstance(v, str) else (v.lower() == "true")
                elif k in ("displayName", "userName", "externalId"):
                    out[_snake(k)] = v
    return out


def _snake(camel: str) -> str:
    return {
        "displayName": "display_name",
        "userName": "user_name",
        "externalId": "external_id",
    }.get(camel, camel)


__all__ = [
    "ScimConfig",
    "ScimConfigStore",
    "ScimUser",
    "ScimUserStore",
    "ScimGroup",
    "ScimGroupStore",
    "build_scim_user",
    "build_scim_group",
    "scim_error",
    "service_provider_config",
    "resource_types",
    "parse_userName",
    "parse_primary_email",
    "apply_patch_ops",
    "apply_group_patch_ops",
    "SCIM_USER_SCHEMA",
    "SCIM_GROUP_SCHEMA",
    "SCIM_LIST_SCHEMA",
    "SCIM_ERROR_SCHEMA",
    "SCIM_PATCH_SCHEMA",
]
