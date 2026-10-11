"""Baseline tests: health endpoint, error envelope, security headers."""


def test_health_ok(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["environment"] == "test"
    database = [c for c in body["checks"] if c["name"] == "database"]
    assert database and database[0]["status"] == "ok"
    # Provider checks are real environment probes; in the test env no
    # credentials are guaranteed, so each must report either state honestly.
    provider_checks = [c for c in body["checks"] if c["name"].startswith("provider:")]
    assert len(provider_checks) >= 5
    assert all(c["status"] in ("configured", "not_configured") for c in provider_checks)


def test_unknown_route_returns_error_envelope(client):
    response = client.get("/api/v1/does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["error"]["code"] == "not_found"
    assert body["request_id"]


def test_security_headers_present(client):
    response = client.get("/api/v1/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["X-Request-ID"]


def test_openapi_document_generated(client):
    response = client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    spec = response.json()
    assert spec["info"]["title"] == "TruthBench AI"
    assert "/api/v1/health" in spec["paths"]
