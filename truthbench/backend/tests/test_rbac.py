"""RBAC, admin endpoints, audit log, and tenant isolation tests."""

from fastapi.testclient import TestClient

from tests.test_auth import (
    DEMO_LOGIN_PHRASE,
    _auth_headers,
    _login_body,
    _register_body,
)


def _admin_auth(client: TestClient, email: str = "admin@example.com") -> dict:
    client.post("/api/v1/auth/register", json=_register_body(email))
    return client.post("/api/v1/auth/login", json=_login_body(email)).json()


def _create_user(client: TestClient, admin_auth: dict, email: str, role: str):
    body = {
        "email": email,
        "passphrase": DEMO_LOGIN_PHRASE,
        "display_name": email.split("@")[0],
        "role": role,
    }
    return client.post("/api/v1/admin/users", json=body, headers=_auth_headers(admin_auth))


def test_admin_can_create_and_list_users(client: TestClient):
    admin_auth = _admin_auth(client)
    assert _create_user(client, admin_auth, "researcher@example.com", "researcher").status_code == 201
    assert _create_user(client, admin_auth, "viewer@example.com", "viewer").status_code == 201

    res = client.get("/api/v1/admin/users", headers=_auth_headers(admin_auth))
    assert res.status_code == 200
    body = res.json()
    assert body["pagination"]["total"] == 3  # admin + two created users
    assert {u["role"] for u in body["items"]} == {"admin", "researcher", "viewer"}


def test_viewer_cannot_access_admin_endpoints(client: TestClient):
    admin_auth = _admin_auth(client)
    _create_user(client, admin_auth, "viewer@example.com", "viewer")
    viewer_auth = client.post(
        "/api/v1/auth/login", json=_login_body("viewer@example.com")
    ).json()
    res = client.get("/api/v1/admin/users", headers=_auth_headers(viewer_auth))
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "permission_denied"


def test_researcher_cannot_create_users(client: TestClient):
    admin_auth = _admin_auth(client)
    _create_user(client, admin_auth, "res@example.com", "researcher")
    res_auth = client.post("/api/v1/auth/login", json=_login_body("res@example.com")).json()
    body = {
        "email": "someone@example.com",
        "passphrase": DEMO_LOGIN_PHRASE,
        "display_name": "Someone",
        "role": "viewer",
    }
    res = client.post("/api/v1/admin/users", json=body, headers=_auth_headers(res_auth))
    assert res.status_code == 403


def test_admin_cannot_deactivate_self(client: TestClient):
    admin_auth = _admin_auth(client)
    me = client.get("/api/v1/auth/me", headers=_auth_headers(admin_auth)).json()
    res = client.patch(
        f"/api/v1/admin/users/{me['id']}",
        json={"is_active": False},
        headers=_auth_headers(admin_auth),
    )
    assert res.status_code == 422


def test_admin_can_change_role_and_deactivate_others(client: TestClient):
    admin_auth = _admin_auth(client)
    created = _create_user(client, admin_auth, "temp@example.com", "viewer").json()

    res = client.patch(
        f"/api/v1/admin/users/{created['id']}",
        json={"role": "researcher"},
        headers=_auth_headers(admin_auth),
    )
    assert res.status_code == 200
    assert res.json()["role"] == "researcher"

    res2 = client.patch(
        f"/api/v1/admin/users/{created['id']}",
        json={"is_active": False},
        headers=_auth_headers(admin_auth),
    )
    assert res2.status_code == 200
    assert res2.json()["is_active"] is False

    login = client.post("/api/v1/auth/login", json=_login_body("temp@example.com"))
    assert login.status_code == 401


def test_audit_log_records_actions(client: TestClient):
    admin_auth = _admin_auth(client)
    _create_user(client, admin_auth, "aud@example.com", "viewer")
    res = client.get("/api/v1/admin/audit", headers=_auth_headers(admin_auth))
    assert res.status_code == 200
    actions = {e["action"] for e in res.json()["items"]}
    assert "auth.register" in actions
    assert "auth.login" in actions
    assert "user.created" in actions


def test_user_management_scoped_to_own_organization(client: TestClient):
    org_a = _admin_auth(client, "a-admin@example.com")
    org_b = _admin_auth(client, "b-admin@example.com")
    _create_user(client, org_a, "a-member@example.com", "researcher")

    res_b = client.get("/api/v1/admin/users", headers=_auth_headers(org_b))
    assert {u["email"] for u in res_b.json()["items"]} == {"b-admin@example.com"}

    res_a = client.get("/api/v1/admin/users", headers=_auth_headers(org_a))
    assert {u["email"] for u in res_a.json()["items"]} == {
        "a-admin@example.com",
        "a-member@example.com",
    }

    # org B admin cannot modify org A users (they are invisible -> 404)
    a_member_id = next(u["id"] for u in res_a.json()["items"] if u["email"] == "a-member@example.com")
    res = client.patch(
        f"/api/v1/admin/users/{a_member_id}",
        json={"role": "viewer"},
        headers=_auth_headers(org_b),
    )
    assert res.status_code == 404


def test_audit_log_scoped_to_own_organization(client: TestClient):
    org_a = _admin_auth(client, "iso-a@example.com")
    _admin_auth(client, "iso-b@example.com")
    res = client.get("/api/v1/admin/audit", headers=_auth_headers(org_a))
    assert res.status_code == 200
    actor_ids = {str(e["actor_user_id"]) for e in res.json()["items"] if e["actor_user_id"]}
    me = client.get("/api/v1/auth/me", headers=_auth_headers(org_a)).json()
    assert actor_ids == {me["id"]}
