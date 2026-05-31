"""SSRF / destination-allowlist guard for outbound webhooks.

The conftest opts every other test out of the strict guard by setting
``SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE=1`` so existing fixtures using
RFC 6761 ``*.test`` names keep working. This file flips the guard
back on for the duration of each test to exercise the real policy.
"""
from __future__ import annotations
import os
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from signalclaw.api import app
from signalclaw.webhooks import _default_http
from signalclaw.webhooks.destination import (
    DestinationPolicy,
    validate_destination,
    validate_destination_or_raise,
)

HEAD = {"x-api-key": "test-key"}


@pytest.fixture
def strict_guard(monkeypatch):
    monkeypatch.delenv("SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE", raising=False)
    monkeypatch.delenv("SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST", raising=False)
    yield


@pytest.fixture
def public_only(monkeypatch):
    # Strict guard plus an allowlist of one obviously public host.
    monkeypatch.delenv("SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE", raising=False)
    monkeypatch.setenv("SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST", "example.com")
    yield


def test_destination_rejects_loopback(strict_guard):
    ok, reason = validate_destination("http://127.0.0.1/hook")
    assert not ok
    assert "non-public" in reason


def test_destination_rejects_link_local_metadata(strict_guard):
    ok, reason = validate_destination("http://169.254.169.254/latest/meta-data/")
    assert not ok
    assert "non-public" in reason


def test_destination_rejects_private_rfc1918(strict_guard):
    ok, reason = validate_destination("http://10.0.0.5:8080/x")
    assert not ok
    ok2, _ = validate_destination("http://192.168.1.1/hook")
    assert not ok2
    ok3, _ = validate_destination("http://172.16.0.1/hook")
    assert not ok3


def test_destination_rejects_credentials_in_url(strict_guard):
    ok, reason = validate_destination("https://user:pass@example.com/hook")
    assert not ok
    assert "credentials" in reason


def test_destination_rejects_non_http_scheme(strict_guard):
    ok, _ = validate_destination("file:///etc/passwd")
    assert not ok
    ok2, _ = validate_destination("gopher://example.com/")
    assert not ok2


def test_destination_rejects_unresolvable_host(strict_guard):
    ok, reason = validate_destination(
        "https://this-host-does-not-exist-12345.invalid/hook")
    assert not ok
    assert "resolve" in reason or "non-public" in reason


def test_destination_accepts_public_ip(strict_guard):
    # 1.1.1.1 is Cloudflare DNS, unambiguously public.
    ok, reason = validate_destination("https://1.1.1.1/hook")
    assert ok, reason


def test_allowlist_blocks_unlisted_host(public_only):
    # example.org is public but not on the one-entry allowlist.
    ok, reason = validate_destination("https://1.1.1.1/hook")
    assert not ok
    assert "allowlist" in reason


def test_allowlist_accepts_listed_host(public_only):
    ok, reason = validate_destination("https://example.com/hook")
    assert ok, reason


def test_api_post_webhooks_rejects_loopback(strict_guard):
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD,
               json={"url": "http://127.0.0.1:9000/hook"})
    assert r.status_code == 400
    assert "non-public" in r.text


def test_api_post_webhooks_rejects_metadata_ip(strict_guard):
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD,
               json={"url": "http://169.254.169.254/latest/meta-data/"})
    assert r.status_code == 400


def test_api_post_webhooks_rejects_credentialed_url(strict_guard):
    c = TestClient(app)
    r = c.post("/webhooks", headers=HEAD,
               json={"url": "https://user:pass@example.com/hook"})
    assert r.status_code == 400


def test_delivery_http_refuses_blocked_destination(strict_guard):
    # _default_http is what the real delivery + replay path runs.
    status, err = _default_http(
        "http://127.0.0.1/hook", b"{}", {"content-type": "application/json"})
    assert status == 0
    assert "destination_blocked" in err


def test_policy_from_env_parses_allowlist(monkeypatch):
    monkeypatch.setenv("SIGNALCLAW_WEBHOOK_HOST_ALLOWLIST",
                       " a.example.com , b.example.com ,, ")
    monkeypatch.setenv("SIGNALCLAW_WEBHOOK_ALLOW_PRIVATE", "true")
    p = DestinationPolicy.from_env()
    assert p.allow_private is True
    assert p.host_allowlist == ("a.example.com", "b.example.com")
