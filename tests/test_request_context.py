"""Tests for request-id / correlation-id middleware.

Covers:
* Outbound ``X-Request-Id`` header is always set.
* A well-formed inbound id is honoured end-to-end.
* A malformed inbound id is rejected and a fresh id is minted.
* ``X-Correlation-Id`` is propagated when supplied but never minted.
* The bound contextvar is visible to handler-side ``structlog`` logs.
* Contextvars are cleared once the request finishes so requests do
  not leak state into each other.
"""
from __future__ import annotations

import json

import pytest
import structlog
from fastapi import FastAPI
from starlette.testclient import TestClient

from signalclaw.api.request_context import (
    CORRELATION_ID_HEADER,
    REQUEST_ID_HEADER,
    RequestContextMiddleware,
)
from signalclaw.logging_ import configure_logging, get_logger


@pytest.fixture
def app() -> FastAPI:
    a = FastAPI()
    a.add_middleware(RequestContextMiddleware)

    @a.get("/echo")
    def echo():
        # Pull the merged contextvars directly so the test can assert
        # what a downstream logger would see, without depending on a
        # capture handler.
        merged = structlog.contextvars.get_contextvars()
        return {"ctx": merged}

    return a


def test_outbound_header_minted(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.get("/echo")
    assert r.status_code == 200
    rid = r.headers[REQUEST_ID_HEADER]
    assert rid and len(rid) >= 8
    assert r.json()["ctx"]["request_id"] == rid


def test_inbound_header_honoured(app: FastAPI) -> None:
    client = TestClient(app)
    incoming = "abc123-DEADBEEF_42"
    r = client.get("/echo", headers={REQUEST_ID_HEADER: incoming})
    assert r.headers[REQUEST_ID_HEADER] == incoming
    assert r.json()["ctx"]["request_id"] == incoming


def test_malformed_inbound_rejected(app: FastAPI) -> None:
    client = TestClient(app)
    # newline + control chars would corrupt JSON log shipping
    bad = "evil\nvalue with spaces"
    r = client.get("/echo", headers={REQUEST_ID_HEADER: bad})
    assert r.headers[REQUEST_ID_HEADER] != bad
    assert r.json()["ctx"]["request_id"] != bad


def test_correlation_id_propagated(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.get("/echo", headers={CORRELATION_ID_HEADER: "job-7788"})
    assert r.headers[CORRELATION_ID_HEADER] == "job-7788"
    assert r.json()["ctx"]["correlation_id"] == "job-7788"


def test_correlation_id_not_minted(app: FastAPI) -> None:
    client = TestClient(app)
    r = client.get("/echo")
    assert CORRELATION_ID_HEADER not in r.headers
    assert "correlation_id" not in r.json()["ctx"]


def test_contextvars_cleared_between_requests(app: FastAPI) -> None:
    client = TestClient(app)
    client.get("/echo", headers={CORRELATION_ID_HEADER: "first"})
    # After request returns, the contextvars must be empty so a
    # subsequent log line in the worker (for example a background
    # task) does not inherit the previous request's correlation id.
    assert structlog.contextvars.get_contextvars() == {}


def test_request_id_appears_in_structlog_output(app: FastAPI, capsys) -> None:
    # Exercise the real logging stack to prove the contextvar reaches
    # JSON output, which is what log shippers actually consume.
    configure_logging("INFO")
    log = get_logger("test")

    @app.get("/log")
    def log_route():
        log.info("hello.world", extra_field="x")
        return {"ok": True}

    client = TestClient(app)
    r = client.get("/log", headers={REQUEST_ID_HEADER: "trace-aaa111"})
    assert r.status_code == 200
    captured = capsys.readouterr().out
    # Find the JSON line our handler emitted
    hit = None
    for line in captured.splitlines():
        if "hello.world" in line:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if parsed.get("event") == "hello.world":
                hit = parsed
                break
    assert hit is not None, f"hello.world log not found in:\n{captured}"
    assert hit["request_id"] == "trace-aaa111"
