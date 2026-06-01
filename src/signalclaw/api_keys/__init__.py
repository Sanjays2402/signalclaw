"""User-managed API key store with persistent JSON backing.

This complements the env-based ``ApiKeyRegistry`` in
``signalclaw.api.rate_limit`` by letting users mint and revoke their
own keys through the dashboard without redeploying.

Keys are stored as a SHA-256 hash of the secret, never the secret
itself. The full secret is returned exactly once at creation time so
the UI can show it and then forget it.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import threading
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set


_PREFIX = "sck_"  # signalclaw key
_SECRET_BYTES = 24  # 32 chars of url-safe b64


# --- RBAC roles -------------------------------------------------------
# Enterprise procurement reviewers expect classic four-tier RBAC layered
# on top of the scope system, not just a flat scope list. A role caps
# the maximum scopes a key can ever exercise: requested scopes are
# intersected with the role's allowed set, and the role gets surfaced
# in admin UIs so an owner can see who has what at a glance.
#
# * ``viewer``  -- read only. Cannot mutate anything.
# * ``member``  -- read + trade. Cannot manage keys, MFA, or org settings.
# * ``admin``   -- read + trade + admin (manage keys, members, audit).
# * ``owner``   -- everything admin can do, plus is recorded as the
#                  workspace owner for billing and ownership transfers.
#                  At the API layer owner == admin scopes.
ROLES: tuple[str, ...] = ("owner", "admin", "member", "viewer")
ROLE_SCOPES: Dict[str, Set[str]] = {
    "owner":  {"read", "trade", "admin"},
    "admin":  {"read", "trade", "admin"},
    "member": {"read", "trade"},
    "viewer": {"read"},
}
DEFAULT_ROLE = "member"


def normalise_role(role: Optional[str]) -> str:
    """Coerce a possibly-bad role string to a valid role.

    Unknown or empty roles fall through to ``DEFAULT_ROLE`` rather than
    raising so a corrupted on-disk row can never silently escalate to a
    higher-privilege role. The caller can still pre-validate at the API
    boundary with ``ROLES`` for a 400 response.
    """
    r = (role or "").strip().lower()
    return r if r in ROLE_SCOPES else DEFAULT_ROLE


def cap_scopes_to_role(scopes: Iterable[str], role: Optional[str]) -> List[str]:
    """Return the requested scopes intersected with the role's allowed set.

    This is the single chokepoint that enforces RBAC: even if a stored
    row claims ``["admin"]`` scopes, a ``viewer`` role drops it to
    ``["read"]``. Always returns at least ``["read"]`` so an authed
    key can still do something (typically self-introspection).
    """
    allowed = ROLE_SCOPES[normalise_role(role)]
    out = sorted({s for s in (scopes or []) if s in allowed})
    return out or ["read"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _iso_in(seconds: int) -> str:
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(seconds=int(seconds))).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def _grace_active(grace_until: Optional[str]) -> bool:
    if not grace_until:
        return False
    try:
        # Compare as ISO strings (UTC, fixed-width). Lexical order matches
        # chronological order for this format.
        return grace_until > _now_iso()
    except Exception:
        return False


def _mint() -> str:
    return _PREFIX + secrets.token_urlsafe(_SECRET_BYTES)


def normalise_cidrs(cidrs: Iterable[str]) -> List[str]:
    """Validate and normalise a list of CIDR blocks or bare IPs.

    Bare IPs become host networks (``/32`` or ``/128``). Duplicates are
    collapsed, order is stable, and the result is always strict
    networks so a future ``ip_address in network`` check is safe.
    Raises ``ValueError`` on the first bad entry.
    """
    out: List[str] = []
    seen: Set[str] = set()
    for raw in cidrs or []:
        s = (raw or "").strip()
        if not s:
            continue
        try:
            if "/" in s:
                net = ipaddress.ip_network(s, strict=False)
            else:
                # Bare IP -> host network so membership tests work uniformly.
                addr = ipaddress.ip_address(s)
                net = ipaddress.ip_network(
                    f"{addr}/{addr.max_prefixlen}", strict=False)
        except ValueError as exc:
            raise ValueError(f"invalid CIDR or IP: {s!r}: {exc}")
        key = str(net)
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
        if len(out) >= 64:
            # Hard cap to keep the JSON file small and per-request checks O(1)-ish.
            raise ValueError("ip_allowlist may contain at most 64 entries")
    return out


def is_expired(stored: "StoredKey") -> bool:
    """Return True if ``stored`` has a populated ``expires_at`` in the past.

    Keys with no expiry are never expired. Unparseable or malformed
    timestamps fail closed (treated as expired) so a corrupted file
    cannot accidentally keep a credential alive past its intended
    lifetime. The expected shape is the fixed-width ISO-8601 UTC
    string produced by ``_iso_in`` / ``_now_iso``.
    """
    exp = (getattr(stored, "expires_at", None) or "").strip()
    if not exp:
        return False
    try:
        # strptime guards against arbitrary strings that would otherwise
        # lex-compare in unintuitive ways (e.g. "not-a-date" > "2026-..").
        datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return True
    try:
        return exp <= _now_iso()
    except Exception:
        return True


def review_due_at(stored: "StoredKey") -> Optional[str]:
    """Return the ISO-8601 UTC instant when this key's next access
    review is due, or ``None`` if it has no creation timestamp.

    The clock starts at the most recent of ``last_reviewed_at`` and
    ``created_at`` (so a brand-new key is not instantly overdue; it
    has the full window to be attested) and ticks forward by
    ``review_interval_days`` (clamped to a sane 1..365). Unparseable
    timestamps fail closed: we treat them as due immediately so an
    auditor sees the row in the overdue list rather than silently
    losing it.
    """
    anchor = (stored.last_reviewed_at or stored.created_at or "").strip()
    if not anchor:
        return None
    try:
        base = datetime.strptime(anchor, "%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        # Surface as immediately due; an admin can re-attest and the
        # next call recomputes from a known-good timestamp.
        return _now_iso()
    days = int(getattr(stored, "review_interval_days", 90) or 90)
    days = max(1, min(365, days))
    return (base + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_review_overdue(stored: "StoredKey") -> bool:
    """Return True if the next review is due in the past.

    Revoked keys are never overdue (you don't attest a dead credential)
    so the admin queue stays focused on live access. Suspended keys are
    still listed because they may be unsuspended; an auditor wants to
    know they exist.
    """
    if getattr(stored, "revoked", False):
        return False
    due = review_due_at(stored)
    if not due:
        return False
    try:
        return due <= _now_iso()
    except Exception:
        return True


def is_ip_allowed(stored: "StoredKey", client_ip: str) -> bool:
    """Return True if ``client_ip`` matches the key's allowlist.

    Keys with an empty allowlist are unrestricted. An unparseable
    ``client_ip`` against a restricted key is always denied (fail
    closed) so a missing/garbled X-Forwarded-For cannot bypass the
    policy by accident.
    """
    cidrs = stored.ip_allowlist or []
    if not cidrs:
        return True
    if not client_ip:
        return False
    try:
        addr = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    for c in cidrs:
        try:
            if addr in ipaddress.ip_network(c, strict=False):
                return True
        except ValueError:
            continue
    return False


@dataclass
class StoredKey:
    id: str
    label: str
    hash: str
    prefix: str  # first 12 chars of the secret for display
    scopes: List[str]
    created_at: str
    last_used_at: Optional[str] = None
    revoked: bool = False
    # Optional CIDR allowlist. When non-empty, requests authenticated with
    # this key are rejected with 403 unless the client IP falls inside one
    # of the listed networks. Stored as strings so the JSON file stays
    # human-readable; parsed on demand by ``is_ip_allowed``.
    ip_allowlist: List[str] = field(default_factory=list)
    # Rotation: when a key is rotated with a grace window, the previous
    # secret hash stays valid for a bounded time so live integrations can
    # roll over without downtime. ``previous_hash`` is the SHA-256 of the
    # old secret; ``previous_grace_until`` is an ISO-8601 UTC timestamp
    # after which the old hash is rejected and stripped on next write.
    previous_hash: Optional[str] = None
    previous_grace_until: Optional[str] = None
    rotated_at: Optional[str] = None
    # Optional hard expiry. SOC2-style hygiene requires that credentials
    # cannot live forever. When set, ``lookup`` rejects the key once the
    # ISO-8601 UTC timestamp is in the past and the cache is reloaded.
    # ``None`` (the default) means the key never expires.
    expires_at: Optional[str] = None
    # RBAC role. ``member`` by default so existing rows that predate
    # this field keep working with read+trade access (matches the old
    # implicit behaviour). ``owner``/``admin`` carry the ``admin`` scope.
    role: str = DEFAULT_ROLE
    # Forensic last-use fingerprint. Enterprise procurement and SOC2
    # incident response need to answer "who used this credential, from
    # where, with what client?" without trawling raw logs. We persist the
    # most recent client IP and a truncated User-Agent alongside
    # ``last_used_at`` and surface them in /admin/keys + the settings UI.
    # Both default to ``None`` so legacy rows on disk keep deserialising.
    last_used_ip: Optional[str] = None
    last_used_user_agent: Optional[str] = None
    # Reversible disable, distinct from ``revoked`` (which is a
    # permanent tombstone). A suspended key is dropped from the auth
    # index so every request authenticated with it fails 401, but the
    # row keeps its scopes, role, ip-allowlist, expiry, and forensic
    # fingerprint so an operator can resume it in one click after an
    # incident review. SOC2-style hygiene: incident responders need a
    # "pause this credential" surface that is not destructive.
    suspended: bool = False
    suspended_at: Optional[str] = None
    suspended_reason: Optional[str] = None
    suspended_by: Optional[str] = None
    # Periodic access review (SOC2 CC6.3 / ISO 27001 A.9.2.5). Each key
    # must be re-attested by an admin every ``review_interval_days``;
    # ``last_reviewed_at`` records the most recent attestation ISO-8601
    # UTC. ``review_interval_days`` defaults to 90 (the standard SOC2
    # cadence) and is clamped to 1..365 by ``set_review_interval``.
    # ``last_reviewed_by`` stores the actor id/prefix that performed
    # the review so an auditor can trace each attestation back to a
    # person, not just a system event. ``None`` means the key has
    # never been reviewed (it was created and never attested).
    last_reviewed_at: Optional[str] = None
    last_reviewed_by: Optional[str] = None
    review_interval_days: int = 90

    def to_public(self) -> Dict:
        d = asdict(self)
        d.pop("hash")
        d.pop("previous_hash", None)
        d["expired"] = is_expired(self)
        d["suspended"] = bool(self.suspended)
        # Expose the effective scopes after the role cap so the UI and
        # any operator script sees what the key can actually do, not
        # what an older on-disk row happens to list.
        d["role"] = normalise_role(self.role)
        d["effective_scopes"] = cap_scopes_to_role(self.scopes, self.role)
        d["review_due_at"] = review_due_at(self)
        d["review_overdue"] = is_review_overdue(self)
        return d


class ApiKeyStore:
    """JSON-backed persistent key store. Thread-safe."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self.path.exists():
            self.path.write_text(json.dumps({"keys": []}, indent=2))
        # in-memory index from hash -> StoredKey for O(1) lookup on each request
        self._index: Dict[str, StoredKey] = {}
        self._reload_index()

    def _reload_index(self) -> None:
        rows = self._read()
        idx: Dict[str, StoredKey] = {}
        for r in rows:
            if r.revoked:
                continue
            if r.suspended:
                # Suspended keys must fail auth without being removed:
                # keep them out of the lookup index. ``list``/``get``
                # still surface them in admin views.
                continue
            if is_expired(r):
                # Treat hard-expired keys exactly like revoked ones: never
                # indexed, never returned by lookup. The on-disk row is
                # preserved (audit trail) until an admin prunes it.
                continue
            idx[r.hash] = r
            # Also index the grace-window predecessor so a still-rotating
            # client can authenticate until ``previous_grace_until`` passes.
            if r.previous_hash and _grace_active(r.previous_grace_until):
                idx[r.previous_hash] = r
        self._index = idx

    def _read(self) -> List[StoredKey]:
        raw = json.loads(self.path.read_text() or '{"keys":[]}')
        out: List[StoredKey] = []
        for r in raw.get("keys", []):
            out.append(StoredKey(
                id=r["id"],
                label=r.get("label", ""),
                hash=r["hash"],
                prefix=r.get("prefix", ""),
                scopes=list(r.get("scopes", ["read"])),
                created_at=r.get("created_at", _now_iso()),
                last_used_at=r.get("last_used_at"),
                revoked=bool(r.get("revoked", False)),
                ip_allowlist=list(r.get("ip_allowlist", []) or []),
                previous_hash=r.get("previous_hash") or None,
                previous_grace_until=r.get("previous_grace_until") or None,
                rotated_at=r.get("rotated_at") or None,
                expires_at=r.get("expires_at") or None,
                role=normalise_role(r.get("role")),
                last_used_ip=r.get("last_used_ip") or None,
                last_used_user_agent=r.get("last_used_user_agent") or None,
                suspended=bool(r.get("suspended", False)),
                suspended_at=r.get("suspended_at") or None,
                suspended_reason=r.get("suspended_reason") or None,
                suspended_by=r.get("suspended_by") or None,
                last_reviewed_at=r.get("last_reviewed_at") or None,
                last_reviewed_by=r.get("last_reviewed_by") or None,
                review_interval_days=int(r.get("review_interval_days", 90) or 90),
            ))
        return out

    def _write(self, rows: List[StoredKey]) -> None:
        self.path.write_text(json.dumps(
            {"keys": [asdict(r) for r in rows]}, indent=2, sort_keys=True))

    def list(self) -> List[StoredKey]:
        return self._read()

    def create(
        self,
        label: str,
        scopes: Optional[List[str]] = None,
        expires_in_seconds: Optional[int] = None,
        role: Optional[str] = None,
    ) -> tuple[StoredKey, str]:
        """Mint a new key. Returns (record, full_secret).

        The full secret is only returned here. Callers must surface it
        to the user immediately and never log it. ``expires_in_seconds``
        sets an optional hard expiry (clamped to one year) so credentials
        cannot live forever; pass ``None`` or ``0`` for no expiry.
        """
        label = (label or "").strip()[:80] or "unnamed"
        role_norm = normalise_role(role)
        scope_set: Set[str] = set(scopes or ["read"])
        # ``admin`` may only land in the scope set when the role itself
        # carries admin (owner / admin). For member / viewer the cap
        # below strips it anyway, but discarding here also stops a
        # buggy caller from persisting a misleading scope list.
        if "admin" not in ROLE_SCOPES[role_norm]:
            scope_set.discard("admin")
        scope_set = set(cap_scopes_to_role(scope_set, role_norm))
        if not scope_set:
            scope_set = {"read"}
        expires_at: Optional[str] = None
        if expires_in_seconds:
            ttl = max(0, min(int(expires_in_seconds), 365 * 24 * 3600))
            if ttl > 0:
                expires_at = _iso_in(ttl)
        secret = _mint()
        rec = StoredKey(
            id=secrets.token_hex(8),
            label=label,
            hash=_hash(secret),
            prefix=secret[:12],
            scopes=sorted(scope_set),
            created_at=_now_iso(),
            expires_at=expires_at,
            role=role_norm,
        )
        with self._lock:
            rows = self._read()
            rows.append(rec)
            self._write(rows)
            self._reload_index()
        return rec, secret

    def set_expiry(self, key_id: str, expires_in_seconds: Optional[int]) -> Optional[StoredKey]:
        """Set or clear a key's hard expiry.

        ``expires_in_seconds=None`` or ``0`` clears the expiry (the key
        becomes long-lived again). Positive values are clamped to one
        year so a stale dashboard value cannot create a multi-decade
        credential. Returns the updated record or ``None`` if the key
        is missing or revoked.
        """
        new_exp: Optional[str] = None
        if expires_in_seconds:
            ttl = max(0, min(int(expires_in_seconds), 365 * 24 * 3600))
            if ttl > 0:
                new_exp = _iso_in(ttl)
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.expires_at = new_exp
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def set_role(self, key_id: str, role: str) -> Optional[StoredKey]:
        """Change a key's RBAC role. Re-caps scopes to the new role.

        Raises ``ValueError`` for an unknown role so the API layer can
        return a structured 400 instead of silently downgrading the
        caller's request to ``member``. Returns ``None`` if the key is
        missing or revoked.
        """
        r = (role or "").strip().lower()
        if r not in ROLE_SCOPES:
            raise ValueError(
                f"invalid role {role!r}; must be one of {sorted(ROLES)}")
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for row in rows:
                if row.id == key_id and not row.revoked:
                    row.role = r
                    row.scopes = cap_scopes_to_role(row.scopes, r)
                    updated = row
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def set_label(self, key_id: str, label: str) -> Optional[StoredKey]:
        """Rename an API key without rotating its secret.

        Labels are free-form (1..80 chars). Empty/whitespace input is
        rejected with ``ValueError`` so an admin cannot accidentally
        blank out a key's name and lose track of who owns it. Returns
        the updated record or ``None`` if the key is missing or revoked.
        Suspended keys can still be relabelled; that's a common case
        when handing off ownership during an incident.
        """
        if not isinstance(label, str):
            raise ValueError("label must be a string")
        new_label = label.strip()[:80]
        if not new_label:
            raise ValueError("label must not be empty")
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.label = new_label
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def attest_review(
        self,
        key_id: str,
        reviewer: Optional[str] = None,
    ) -> Optional[StoredKey]:
        """Record an access-review attestation for ``key_id``.

        Stamps ``last_reviewed_at`` to now and ``last_reviewed_by`` to
        ``reviewer`` (truncated to 64 chars). Returns the updated key,
        or ``None`` if the key is missing or revoked. Suspended keys
        can still be reviewed: an auditor may want to attest "yes, we
        looked at this credential and confirmed it stays suspended".
        """
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.last_reviewed_at = _now_iso()
                    r.last_reviewed_by = (reviewer or "").strip()[:64] or None
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def set_review_interval(
        self,
        key_id: str,
        days: int,
    ) -> Optional[StoredKey]:
        """Change how often this key must be re-attested.

        Clamps to 1..365 days. Raises ``ValueError`` for non-integer
        input so the API can return a structured 400. Does not move
        ``last_reviewed_at``; the next-due timestamp recomputes off
        the existing anchor.
        """
        try:
            n = int(days)
        except (TypeError, ValueError):
            raise ValueError("days must be an integer")
        if n < 1 or n > 365:
            raise ValueError("days must be between 1 and 365")
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.review_interval_days = n
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def list_review_overdue(self) -> List[StoredKey]:
        """Return every live key whose access review is past due.

        Used by the admin console queue and the SOC2 evidence pack to
        prove the access-review program is being executed on cadence.
        """
        return [r for r in self._read() if is_review_overdue(r)]

    def set_ip_allowlist(self, key_id: str, cidrs: Iterable[str]) -> Optional[StoredKey]:
        """Replace the IP allowlist on a key. Validates every CIDR.

        An empty list clears the allowlist (allow any source). Raises
        ``ValueError`` if any entry is not a valid IPv4/IPv6 address or
        CIDR block, so the API can return a structured 400.
        """
        normalised = normalise_cidrs(cidrs)
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.ip_allowlist = normalised
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def rotate(self, key_id: str, grace_seconds: int = 0) -> Optional[tuple["StoredKey", str]]:
        """Mint a new secret for ``key_id``; keep old hash valid for ``grace_seconds``.

        Returns ``(record, new_secret)`` so the caller can surface the
        plaintext exactly once. Returns ``None`` if the key is missing
        or already revoked. ``grace_seconds=0`` makes the previous
        secret stop working immediately. The grace window is clamped
        to seven days so a forgotten rotation does not become a long
        lived dual-credential.
        """
        grace = max(0, min(int(grace_seconds or 0), 7 * 24 * 3600))
        new_secret = _mint()
        new_hash = _hash(new_secret)
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    if grace > 0:
                        r.previous_hash = r.hash
                        r.previous_grace_until = _iso_in(grace)
                    else:
                        r.previous_hash = None
                        r.previous_grace_until = None
                    r.hash = new_hash
                    r.prefix = new_secret[:12]
                    r.rotated_at = _now_iso()
                    updated = r
                    break
            if updated is None:
                return None
            self._write(rows)
            self._reload_index()
        return updated, new_secret

    def suspend(self, key_id: str, reason: Optional[str] = None,
                actor: Optional[str] = None) -> Optional[StoredKey]:
        """Reversibly disable a key. Returns the updated row or None.

        A suspended key is dropped from the auth index so any request
        signed with it fails 401. Scopes, role, ip-allowlist, expiry,
        and forensic fingerprint are preserved so :meth:`resume`
        restores the exact prior posture. No-ops on already-suspended
        rows. Refuses revoked rows (revocation is terminal).
        """
        clean_reason = (reason or "").strip()[:200] or None
        clean_actor = (actor or "").strip()[:64] or None
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    if not r.suspended:
                        r.suspended = True
                        r.suspended_at = _now_iso()
                        r.suspended_reason = clean_reason
                        r.suspended_by = clean_actor
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def resume(self, key_id: str, actor: Optional[str] = None) -> Optional[StoredKey]:
        """Lift a prior :meth:`suspend`. No-op on non-suspended rows.

        Clears all four ``suspended_*`` fields so the resumed row
        looks indistinguishable from one that was never suspended.
        Returns the updated row, or ``None`` if the key is missing or
        revoked. ``actor`` is accepted for symmetry with
        :meth:`suspend` but is not persisted: the audit log is the
        canonical record of who resumed a key and when.
        """
        del actor  # audit-log responsibility, not store responsibility
        with self._lock:
            rows = self._read()
            updated: Optional[StoredKey] = None
            for r in rows:
                if r.id == key_id and not r.revoked:
                    if r.suspended:
                        r.suspended = False
                        r.suspended_at = None
                        r.suspended_reason = None
                        r.suspended_by = None
                    updated = r
                    break
            if updated is not None:
                self._write(rows)
                self._reload_index()
            return updated

    def revoke(self, key_id: str) -> bool:
        with self._lock:
            rows = self._read()
            found = False
            for r in rows:
                if r.id == key_id and not r.revoked:
                    r.revoked = True
                    found = True
                    break
            if found:
                self._write(rows)
                self._reload_index()
            return found

    def lookup(self, secret: str, *, client_ip: Optional[str] = None,
               user_agent: Optional[str] = None) -> Optional[StoredKey]:
        """Resolve a raw secret to a stored key (or None).

        Honors the rotation grace window: a recently-rotated key's
        previous secret remains valid until ``previous_grace_until``.
        Once that timestamp passes the predecessor hash is dropped on
        the next index reload so an attacker cannot keep using it.
        """
        if not secret:
            return None
        h = _hash(secret)
        rec = self._index.get(h)
        if rec is None:
            # cache miss may mean a key created in another process; reload once
            with self._lock:
                self._reload_index()
            rec = self._index.get(h)
        if rec is None or rec.revoked:
            return None
        # Reject expired-grace previous hash even if a stale cache served it.
        if h == (rec.previous_hash or "") and not _grace_active(rec.previous_grace_until):
            with self._lock:
                self._reload_index()
            return None
        # Hard-expired keys fail closed. Reload the index so the now-dead
        # hash is dropped from the cache rather than served on the next hit.
        if is_expired(rec):
            with self._lock:
                self._reload_index()
            return None
        # record last_used_at + forensic fingerprint lazily; only persist
        # when the timestamp advances or the IP/UA changed, so the JSON
        # file does not get rewritten on every request.
        try:
            now = _now_iso()
            last = rec.last_used_at or ""
            # Truncate UA so a pathological client cannot bloat the store.
            ua_clean = (user_agent or "").strip()[:256] or None
            ip_clean = (client_ip or "").strip()[:64] or None
            ip_changed = ip_clean is not None and ip_clean != (rec.last_used_ip or None)
            ua_changed = ua_clean is not None and ua_clean != (rec.last_used_user_agent or None)
            ts_advanced = (not last) or last < now
            if ts_advanced or ip_changed or ua_changed:
                if ts_advanced:
                    rec.last_used_at = now
                if ip_clean is not None:
                    rec.last_used_ip = ip_clean
                if ua_clean is not None:
                    rec.last_used_user_agent = ua_clean
                with self._lock:
                    rows = self._read()
                    for r in rows:
                        if r.id == rec.id:
                            if ts_advanced:
                                r.last_used_at = now
                            if ip_clean is not None:
                                r.last_used_ip = ip_clean
                            if ua_clean is not None:
                                r.last_used_user_agent = ua_clean
                            break
                    self._write(rows)
        except Exception:  # pragma: no cover - never block auth on bookkeeping
            pass
        return rec


__all__ = [
    "ApiKeyStore",
    "StoredKey",
    "normalise_cidrs",
    "is_ip_allowed",
    "is_expired",
    "ROLES",
    "ROLE_SCOPES",
    "DEFAULT_ROLE",
    "normalise_role",
    "cap_scopes_to_role",
]
