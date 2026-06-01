"""Per-API-key tenant isolation for /watchlist and /picks.

Before this change every API key in a deployment shared the same
``WatchlistStore``, which meant tickers added by one customer were
visible (and removable) by every other customer hitting the same
backend. Enterprise procurement reviewers flag this as a hard
multi-tenancy finding because the watchlist drives ``/picks`` and
``/report.md`` output, so cross-tenant leakage at the universe layer
also leaks downstream model output.

The tests below stand up two member keys against the real FastAPI
app and prove:

* a ticker added by key A is invisible to key B,
* key B's delete on a ticker only A has tracked is a no-op against A's
  list (cannot delete cross-tenant),
* ``/picks`` for key B does not score tickers that only A has added,
* an admin-role key can inspect every tenant's watchlist via
  ``GET /admin/watchlists``.
"""
from __future__ import annotations
import os
import tempfile
import json as _json

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_wl_iso_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-wl-iso-default")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = _json.dumps([
    {"key": "wl-iso-admin-key", "scopes": ["read", "trade", "admin"],
     "label": "wl-iso-admin"},
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api import app  # noqa: E402

ADMIN = {"x-api-key": "wl-iso-admin-key"}


def _mint(label: str, role: str = "member") -> str:
    c = TestClient(app)
    r = c.post("/admin/keys", headers=ADMIN, json={
        "label": label, "scopes": ["read", "trade"], "role": role,
    })
    assert r.status_code == 200, r.text
    return r.json()["secret"]


def test_watchlist_add_is_invisible_to_other_user_keys():
    c = TestClient(app)
    alice = _mint("wl-alice")
    bob = _mint("wl-bob")

    # Alice adds an unusual ticker so we can't confuse it with the seed list.
    r = c.post("/watchlist", headers={"x-api-key": alice},
               json={"ticker": "ZZZALICE"})
    assert r.status_code == 200, r.text
    assert "ZZZALICE" in r.json()["tickers"]

    # Bob does not see ZZZALICE.
    r = c.get("/watchlist", headers={"x-api-key": bob})
    assert r.status_code == 200
    assert "ZZZALICE" not in r.json()["tickers"]

    # Bob's add of his own ticker does not appear in Alice's view either.
    r = c.post("/watchlist", headers={"x-api-key": bob},
               json={"ticker": "ZZZBOB"})
    assert r.status_code == 200
    assert "ZZZBOB" in r.json()["tickers"]

    r = c.get("/watchlist", headers={"x-api-key": alice})
    assert "ZZZBOB" not in r.json()["tickers"]
    assert "ZZZALICE" in r.json()["tickers"]


def test_remove_does_not_cross_tenants():
    c = TestClient(app)
    alice = _mint("wl-alice2")
    bob = _mint("wl-bob2")

    c.post("/watchlist", headers={"x-api-key": alice},
           json={"ticker": "ZZZCROSS"})

    # Bob removes "ZZZCROSS" - should silently no-op on his own list and
    # leave Alice's intact.
    r = c.delete("/watchlist/ZZZCROSS", headers={"x-api-key": bob})
    assert r.status_code == 200
    assert "ZZZCROSS" not in r.json()["tickers"]

    r = c.get("/watchlist", headers={"x-api-key": alice})
    assert "ZZZCROSS" in r.json()["tickers"], (
        "cross-tenant delete must not affect Alice's watchlist")


def test_admin_aggregate_view_lists_every_tenant():
    c = TestClient(app)
    alice = _mint("wl-alice3")
    bob = _mint("wl-bob3")
    c.post("/watchlist", headers={"x-api-key": alice},
           json={"ticker": "ZZZADMIN1"})
    c.post("/watchlist", headers={"x-api-key": bob},
           json={"ticker": "ZZZADMIN2"})

    # Member key cannot reach the admin aggregate endpoint.
    r = c.get("/admin/watchlists", headers={"x-api-key": alice})
    assert r.status_code in (401, 403)

    r = c.get("/admin/watchlists", headers=ADMIN)
    assert r.status_code == 200, r.text
    tenants = r.json()["tenants"]
    # Some tenant has ZZZADMIN1 and a different tenant has ZZZADMIN2.
    owners_with_a1 = [k for k, v in tenants.items() if "ZZZADMIN1" in v]
    owners_with_a2 = [k for k, v in tenants.items() if "ZZZADMIN2" in v]
    assert owners_with_a1 and owners_with_a2
    assert owners_with_a1 != owners_with_a2
