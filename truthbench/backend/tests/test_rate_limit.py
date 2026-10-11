"""Rate-limiting middleware tests."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import RateLimitMiddleware


def test_rate_limit_blocks_after_threshold():
    app = FastAPI()

    @app.get("/limited")
    def limited():
        return {"ok": True}

    app.add_middleware(
        RateLimitMiddleware, enabled=True, requests=3, window_seconds=60, exempt_paths=()
    )
    client = TestClient(app)

    statuses = [client.get("/limited").status_code for _ in range(5)]
    assert statuses == [200, 200, 200, 429, 429]

    body = client.get("/limited").json()
    assert body["error"]["code"] == "rate_limited"
    assert body["request_id"]


def test_health_path_exempt_by_default():
    middleware = RateLimitMiddleware(
        app=object(), enabled=True, requests=1, window_seconds=60
    )
    assert "/api/v1/health" in middleware.exempt_paths


def test_disabled_middleware_is_transparent():
    app = FastAPI()

    @app.get("/unlimited")
    def unlimited():
        return {"ok": True}

    app.add_middleware(
        RateLimitMiddleware,
        enabled=False,
        requests=1,
        window_seconds=60,
        exempt_paths=(),
    )
    client = TestClient(app)
    statuses = [client.get("/unlimited").status_code for _ in range(10)]
    assert statuses == [200] * 10
