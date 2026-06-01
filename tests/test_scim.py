"""SCIM 2.0 provisioning end-to-end tests.

Proves:
* SCIM is disabled by default and returns 404 until a bearer is minted.
* The bearer must be supplied; calls without it return 401.
* An unknown bearer is rejected with 401, the configured bearer works.
* Creating a User mints a real api key and returns it once.
* PATCH active=false hard-revokes the bound api key (deprovisioning).
* Re-activating mints a fresh api key.
* DELETE removes the user and revokes the key.
* Every mutation is written to the audit log.
"""
from __future__ import annotations

import json
import os
import tempfile

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_scim_test_")
os.environ["DATA_DIR"] = _TMP
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "admin-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402

reset_registry()

from signalclaw.api import app  # noqa: E402
from signalclaw.api_keys import ApiKeyStore  # noqa: E402

ADMIN = {"x-api-key": "admin-key"}


def _rotate_bearer(c: TestClient) -> str:
    r = c.post("/admin/scim/rotate", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bearer_configured"] is True
    assert body["enabled"] is True
    assert body["bearer"].startswith("scim_")
    return body["bearer"]


def test_scim_disabled_until_bearer_minted():
    c = TestClient(app)
    r = c.get("/scim/v2/Users", headers={"authorization": "Bearer anything"})
    assert r.status_code == 404, r.text


def test_scim_provision_lifecycle_audited():
    c = TestClient(app)
    bearer = _rotate_bearer(c)
    auth = {"authorization": f"Bearer {bearer}"}

    # missing bearer
    r = c.get("/scim/v2/Users")
    assert r.status_code == 401, r.text

    # wrong bearer
    r = c.get("/scim/v2/Users", headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401, r.text

    # correct bearer: empty list
    r = c.get("/scim/v2/Users", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totalResults"] == 0
    assert body["Resources"] == []

    # create user -> mints api key
    r = c.post(
        "/scim/v2/Users",
        headers={**auth, "content-type": "application/scim+json"},
        json={
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
            "userName": "alice@example.com",
            "displayName": "Alice Example",
            "externalId": "okta-abc-123",
            "active": True,
            "emails": [{"value": "alice@example.com", "primary": True, "type": "work"}],
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    user_id = body["id"]
    assert body["userName"] == "alice@example.com"
    assert body["active"] is True
    ext = body["urn:signalclaw:scim:extension:1.0"]
    secret = ext["apiKeySecret"]
    key_id = ext["apiKeyId"]
    assert secret.startswith("sck_")

    # The minted key actually works for a read endpoint
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code == 200, r.text

    # PATCH active=false -> deprovision
    r = c.patch(
        f"/scim/v2/Users/{user_id}",
        headers={**auth, "content-type": "application/scim+json"},
        json={
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            "Operations": [{"op": "replace", "value": {"active": False}}],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["active"] is False

    # Revoked api key is now rejected
    r = c.get("/watchlist", headers={"x-api-key": secret})
    assert r.status_code in (401, 403), r.text

    # Confirm the store reflects the revocation
    store = ApiKeyStore(__import__("pathlib").Path(_TMP) / "api_keys.json")
    matches = [k for k in store.list() if k.id == key_id]
    # The key row may remain (revoked flag) or be gone entirely; either
    # way the secret must be dead, which the 401 above already proved.
    if matches:
        assert getattr(matches[0], "revoked", False) is True, "key must be revoked"

    # Reactivate via PATCH active=true -> fresh secret
    r = c.patch(
        f"/scim/v2/Users/{user_id}",
        headers={**auth, "content-type": "application/scim+json"},
        json={
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            "Operations": [{"op": "replace", "value": {"active": True}}],
        },
    )
    assert r.status_code == 200, r.text
    body2 = r.json()
    assert body2["active"] is True
    new_secret = body2["urn:signalclaw:scim:extension:1.0"]["apiKeySecret"]
    assert new_secret != secret

    # DELETE -> 204, key revoked, user gone
    r = c.delete(f"/scim/v2/Users/{user_id}", headers=auth)
    assert r.status_code == 204, r.text
    r = c.get(f"/scim/v2/Users/{user_id}", headers=auth)
    assert r.status_code == 404, r.text
    r = c.get("/watchlist", headers={"x-api-key": new_secret})
    assert r.status_code in (401, 403), r.text

    # Audit log contains the SCIM events
    from signalclaw.audit import get_audit_log
    from pathlib import Path
    al = get_audit_log(Path(_TMP) / "audit")
    events = al.tail(limit=500)
    actions = {e.get("action") for e in events}
    assert "scim.user.create" in actions
    assert "scim.user.deactivate" in actions
    assert "scim.user.reactivate" in actions
    assert "scim.user.delete" in actions


def test_scim_bearer_required_on_every_method():
    c = TestClient(app)
    _rotate_bearer(c)
    for method, path in [
        ("get", "/scim/v2/Users"),
        ("get", "/scim/v2/Users/nope"),
        ("post", "/scim/v2/Users"),
        ("put", "/scim/v2/Users/nope"),
        ("patch", "/scim/v2/Users/nope"),
        ("delete", "/scim/v2/Users/nope"),
    ]:
        kwargs = {"json": {}} if method in ("post", "put", "patch") else {}
        r = getattr(c, method)(path, **kwargs)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}"


def test_scim_filter_by_username():
    c = TestClient(app)
    bearer = _rotate_bearer(c)
    auth = {"authorization": f"Bearer {bearer}"}
    c.post("/scim/v2/Users", headers={**auth, "content-type": "application/scim+json"},
           json={"userName": "bob@example.com", "active": True})
    c.post("/scim/v2/Users", headers={**auth, "content-type": "application/scim+json"},
           json={"userName": "carol@example.com", "active": True})
    r = c.get('/scim/v2/Users?filter=userName eq "bob@example.com"', headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["totalResults"] == 1
    assert body["Resources"][0]["userName"] == "bob@example.com"


def _make_user(c: TestClient, auth: dict, uname: str) -> str:
    r = c.post(
        "/scim/v2/Users",
        headers={**auth, "content-type": "application/scim+json"},
        json={"userName": uname, "active": True},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _fetch_key_role(key_id: str) -> str | None:
    from pathlib import Path
    store = ApiKeyStore(Path(_TMP) / "api_keys.json")
    for k in store.list():
        if k.id == key_id:
            return k.role
    return None


def test_scim_group_lifecycle_promotes_and_demotes_role():
    """Adding a user to an admin-role group promotes their key;
    removing them demotes it back to the SCIM default."""
    c = TestClient(app)
    bearer = _rotate_bearer(c)
    auth = {"authorization": f"Bearer {bearer}"}
    sjson = {**auth, "content-type": "application/scim+json"}

    user_id = _make_user(c, auth, "dana@example.com")
    user_resp = c.get(f"/scim/v2/Users/{user_id}", headers=auth).json()
    key_id = None
    # extension carries apiKeyId on create response; re-fetch from admin view
    admin_users = c.get("/admin/scim/users", headers=ADMIN).json()
    for u in admin_users["users"]:
        if u["id"] == user_id:
            key_id = u["key_id"]
    assert key_id, admin_users
    # default role from SCIM policy is "member"
    assert _fetch_key_role(key_id) == "member"

    # create admin-role group with this user as initial member
    r = c.post("/scim/v2/Groups", headers=sjson, json={
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        "displayName": "platform-admins",
        "externalId": "okta:grp:platform-admins",
        "urn:signalclaw:scim:extension:1.0": {"role": "admin"},
        "members": [{"value": user_id}],
    })
    assert r.status_code == 201, r.text
    group_id = r.json()["id"]
    assert _fetch_key_role(key_id) == "admin", "membership should promote role"

    # PATCH remove the member -> role falls back to member
    r = c.patch(f"/scim/v2/Groups/{group_id}", headers=sjson, json={
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        "Operations": [
            {"op": "remove", "path": f'members[value eq "{user_id}"]'},
        ],
    })
    assert r.status_code == 200, r.text
    assert _fetch_key_role(key_id) == "member", "removal should demote role"

    # PATCH add them back -> promoted again
    r = c.patch(f"/scim/v2/Groups/{group_id}", headers=sjson, json={
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        "Operations": [
            {"op": "add", "path": "members",
             "value": [{"value": user_id, "display": "dana"}]},
        ],
    })
    assert r.status_code == 200, r.text
    assert _fetch_key_role(key_id) == "admin"

    # delete the group -> demoted
    r = c.delete(f"/scim/v2/Groups/{group_id}", headers=auth)
    assert r.status_code == 204
    assert _fetch_key_role(key_id) == "member"

    # admin surface lists groups (now empty)
    r = c.get("/admin/scim/groups", headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["groups"] == []

    # audit log captured the reconciliation events
    from signalclaw.audit import get_audit_log
    from pathlib import Path as _P
    al = get_audit_log(_P(_TMP) / "audit")
    actions = {e.get("action") for e in al.tail(limit=1000)}
    assert "scim.group.create" in actions
    assert "scim.group.patch" in actions
    assert "scim.group.delete" in actions
    assert "scim.group.role_reconcile" in actions


def test_scim_group_requires_bearer_and_validates_role():
    c = TestClient(app)
    bearer = _rotate_bearer(c)
    auth = {"authorization": f"Bearer {bearer}"}
    sjson = {**auth, "content-type": "application/scim+json"}

    # bearer required
    r = c.get("/scim/v2/Groups")
    assert r.status_code == 401
    r = c.post("/scim/v2/Groups", json={})
    assert r.status_code == 401

    # bad role rejected
    r = c.post("/scim/v2/Groups", headers=sjson, json={
        "displayName": "bad-group",
        "urn:signalclaw:scim:extension:1.0": {"role": "superuser"},
    })
    assert r.status_code == 400, r.text

    # duplicate displayName rejected
    r = c.post("/scim/v2/Groups", headers=sjson, json={
        "displayName": "ops",
        "urn:signalclaw:scim:extension:1.0": {"role": "member"},
    })
    assert r.status_code == 201
    r = c.post("/scim/v2/Groups", headers=sjson, json={
        "displayName": "ops",
        "urn:signalclaw:scim:extension:1.0": {"role": "viewer"},
    })
    assert r.status_code == 409


def test_scim_group_deactivating_user_cascades_membership_cleanup():
    """Deleting a SCIM user removes them from any groups so reconcile
    loops never trip on dangling member ids."""
    c = TestClient(app)
    bearer = _rotate_bearer(c)
    auth = {"authorization": f"Bearer {bearer}"}
    sjson = {**auth, "content-type": "application/scim+json"}

    user_id = _make_user(c, auth, "eve@example.com")
    r = c.post("/scim/v2/Groups", headers=sjson, json={
        "displayName": "analytics",
        "urn:signalclaw:scim:extension:1.0": {"role": "admin"},
        "members": [{"value": user_id}],
    })
    assert r.status_code == 201, r.text
    gid = r.json()["id"]

    # hard-delete the user
    r = c.delete(f"/scim/v2/Users/{user_id}", headers=auth)
    assert r.status_code == 204

    # group must no longer contain the deleted user
    r = c.get(f"/scim/v2/Groups/{gid}", headers=auth)
    assert r.status_code == 200
    assert all(m["value"] != user_id for m in r.json().get("members", []))


def test_scim_resource_types_lists_group():
    c = TestClient(app)
    r = c.get("/scim/v2/ResourceTypes")
    assert r.status_code == 200
    ids = {item["id"] for item in r.json()["Resources"]}
    assert {"User", "Group"} <= ids
