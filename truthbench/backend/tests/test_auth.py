"""Authentication API tests."""

from fastapi.testclient import TestClient

DEMO_LOGIN_PHRASE = "correct-horse-battery-staple-42"


def _register_body(email: str, phrase: str = DEMO_LOGIN_PHRASE) -> dict:
    return {
        "email": email,
        "passphrase": phrase,
        "display_name": "Alice",
        "organization_name": "Alice Research Lab",
    }


def _login_body(email: str, phrase: str = DEMO_LOGIN_PHRASE) -> dict:
    return {"email": email, "passphrase": phrase}


def _auth_headers(auth: dict) -> dict:
    return {"Authorization": f"Bearer {auth['grant']}"}


def test_register_login_me_flow(client: TestClient):
    email = "alice@example.com"
    res = client.post("/api/v1/auth/register", json=_register_body(email))
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["user"]["email"] == email
    assert body["user"]["role"] == "admin"  # first user in a new organization
    assert body["auth"]["grant"]
    assert body["auth"]["renewal"]
    assert body["auth"]["expires_in"] > 0

    login = client.post("/api/v1/auth/login", json=_login_body(email))
    assert login.status_code == 200
    auth = login.json()

    me = client.get("/api/v1/auth/me", headers=_auth_headers(auth))
    assert me.status_code == 200
    assert me.json()["email"] == email


def test_register_duplicate_email_conflict(client: TestClient):
    first = client.post("/api/v1/auth/register", json=_register_body("dup@example.com"))
    assert first.status_code == 201
    again = client.post("/api/v1/auth/register", json=_register_body("dup@example.com"))
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "conflict"


def test_login_wrong_phrase_returns_401(client: TestClient):
    client.post("/api/v1/auth/register", json=_register_body("bob@example.com"))
    wrong = "definitely-not-the-right-phrase-99"
    res = client.post("/api/v1/auth/login", json=_login_body("bob@example.com", wrong))
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "not_authenticated"


def test_register_rejects_weak_phrase(client: TestClient):
    weak = "password123"
    res = client.post("/api/v1/auth/register", json=_register_body("weak@example.com", weak))
    assert res.status_code == 422


def test_register_rejects_malformed_email(client: TestClient):
    res = client.post("/api/v1/auth/register", json=_register_body("not-an-email"))
    assert res.status_code == 422


def test_me_without_token_returns_401(client: TestClient):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_me_with_garbage_token_returns_401(client: TestClient):
    res = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert res.status_code == 401


def test_refresh_flow(client: TestClient):
    email = "refresh@example.com"
    client.post("/api/v1/auth/register", json=_register_body(email))
    auth = client.post("/api/v1/auth/login", json=_login_body(email)).json()
    res = client.post("/api/v1/auth/refresh", json={"renewal": auth["renewal"]})
    assert res.status_code == 200
    refreshed = res.json()
    assert refreshed["grant"]
    assert refreshed["renewal"]

    me = client.get("/api/v1/auth/me", headers=_auth_headers(refreshed))
    assert me.status_code == 200


def test_refresh_rejects_grant_instead_of_renewal(client: TestClient):
    email = "mixup@example.com"
    client.post("/api/v1/auth/register", json=_register_body(email))
    auth = client.post("/api/v1/auth/login", json=_login_body(email)).json()
    res = client.post("/api/v1/auth/refresh", json={"renewal": auth["grant"]})
    assert res.status_code == 401
