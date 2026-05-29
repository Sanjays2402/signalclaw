import os
os.environ.setdefault("SIGNALCLAW_API_KEY", "test-key")
from fastapi.testclient import TestClient
from signalclaw.api import create_app


def test_health():
    app = create_app()
    c = TestClient(app)
    assert c.get("/health").status_code == 200


def test_auth_required():
    app = create_app()
    c = TestClient(app)
    assert c.get("/watchlist").status_code == 401
    assert c.get("/watchlist", headers={"x-api-key": "test-key"}).status_code == 200


def test_disclaimer():
    app = create_app()
    c = TestClient(app)
    r = c.get("/disclaimer").json()
    assert "NOT financial advice" in r["text"]
