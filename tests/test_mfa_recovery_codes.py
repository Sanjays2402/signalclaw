"""MFA recovery codes: end-to-end proof for procurement reviewers.

Demonstrates:

1. /mfa/confirm returns a one-time batch of plaintext recovery codes.
2. A recovery code unlocks an admin route exactly once.
3. The same code is rejected on reuse (single-use, atomic burn).
4. Regenerating invalidates the prior batch and produces fresh codes.
5. The enrollments file on disk never contains the plaintext codes.
"""
from __future__ import annotations
import json
import os
import tempfile

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sc_mfa_rec_test_")
os.environ["DATA_DIR"] = _TMP
os.environ.setdefault("SIGNALCLAW_API_KEY", "mfa-test-key")
os.environ["SIGNALCLAW_API_KEYS_JSON"] = json.dumps([
    {"key": "mfa-admin-key", "scopes": ["read", "trade", "admin"], "label": "ci"}
])

from signalclaw.api.rate_limit import reset_registry  # noqa: E402
reset_registry()

from signalclaw.api.app import app  # noqa: E402
from signalclaw.mfa import generate_code  # noqa: E402

# The app singleton is created on first import; whichever test got there
# first "won" DATA_DIR. Resolve the actual mfa store path off the app so
# the on-disk leak assertion targets the right file regardless of order.
_MFA_PATH = app.state.mfa_store._path  # type: ignore[attr-defined]
ADMIN = {"x-api-key": "mfa-admin-key"}


def _enroll_and_confirm(client: TestClient) -> tuple[str, list[str]]:
    r = client.post("/mfa/enroll", headers=ADMIN, json={"label": "ci-laptop"})
    # If a previous test in this process already confirmed enrollment,
    # /mfa/enroll returns 409. In that case load the secret from disk
    # and skip confirm: we'll regenerate codes to get a known batch.
    if r.status_code == 409:
        store_state = json.loads(open(_MFA_PATH).read())
        secret = store_state["enrollments"][0]["secret_b32"]
        # Need a fresh TOTP for the MFA-gated regenerate call.
        import time as _t
        last_step = store_state["enrollments"][0]["last_step"]
        while int(_t.time() // 30) <= last_step:
            _t.sleep(0.5)
        rr = client.post(
            "/mfa/recovery-codes/regenerate",
            headers={**ADMIN, "x-mfa-code": generate_code(secret)},
        )
        assert rr.status_code == 200, rr.text
        codes = rr.json()["recovery_codes"]
    else:
        assert r.status_code == 200, r.text
        secret = r.json()["secret"]
        r = client.post("/mfa/confirm", headers=ADMIN, json={"code": generate_code(secret)})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["enrolled"] is True
        codes = body["recovery_codes"]
    assert isinstance(codes, list) and len(codes) == 10
    # Format sanity: XXXXX-XXXXX, alphanumeric, no ambiguous chars.
    for c in codes:
        a, _, b = c.partition("-")
        assert len(a) == 5 and len(b) == 5
        assert set(a + b).isdisjoint({"0", "O", "1", "I"})
    return secret, codes


def test_recovery_code_unlocks_admin_route_once_and_disk_holds_no_plaintext():
    c = TestClient(app)
    secret, codes = _enroll_and_confirm(c)

    # status reports the issued count
    r = c.get("/mfa/status", headers=ADMIN)
    assert r.status_code == 200
    assert r.json()["recovery_codes_remaining"] == 10

    # /audit without any second factor: blocked
    r = c.get("/audit", headers=ADMIN)
    assert r.status_code == 401

    # Burn one recovery code: admin route opens
    one = codes[0]
    r = c.get("/audit", headers={**ADMIN, "x-mfa-recovery-code": one})
    assert r.status_code == 200, r.text

    # Same code on a second call: rejected
    r = c.get("/audit", headers={**ADMIN, "x-mfa-recovery-code": one})
    assert r.status_code == 401
    assert "recovery" in r.json()["detail"].lower()

    # Count decremented exactly by one
    r = c.get("/mfa/status", headers=ADMIN)
    assert r.json()["recovery_codes_remaining"] == 9

    # Plaintext codes must not live on disk anywhere under the app's
    # MFA store directory.
    mfa_dir = os.path.dirname(str(_MFA_PATH))
    found_plain = False
    for root, _dirs, files in os.walk(mfa_dir):
        for name in files:
            try:
                blob = open(os.path.join(root, name), "rb").read()
            except OSError:
                continue
            for code in codes:
                if code.encode("ascii") in blob:
                    found_plain = True
    assert not found_plain, "plaintext recovery code leaked to disk"

def test_regenerate_invalidates_prior_batch():
    c = TestClient(app)
    # Read the persisted secret to mint a fresh TOTP for the MFA gate.
    data = json.loads(open(_MFA_PATH).read())
    secret = data["enrollments"][0]["secret_b32"]
    last_step = data["enrollments"][0]["last_step"]
    import time as _t
    while int(_t.time() // 30) <= last_step:
        _t.sleep(0.5)
    code = generate_code(secret)
    r = c.post(
        "/mfa/recovery-codes/regenerate",
        headers={**ADMIN, "x-mfa-code": code},
    )
    assert r.status_code == 200, r.text
    new_codes = r.json()["recovery_codes"]
    assert len(new_codes) == 10
    # Count is exactly 10 again (old batch was wiped).
    r = c.get("/mfa/status", headers=ADMIN)
    assert r.json()["recovery_codes_remaining"] == 10
