"""A first-time owner must have chosen a plan before signing in: no plan, no token and no account. Everyone else signs in as before."""
from __future__ import annotations

from .conftest import new_phone


def _code(client, phone):
    r = client.post("/api/v1/dev/otp/request", json={"phone": phone})
    assert r.status_code == 200, r.text
    return r.json()["demo_code"]


def test_a_new_number_through_the_owner_door_without_a_plan_gets_no_token(client):
    phone = new_phone()
    r = client.post("/api/v1/dev/otp/verify", json={"phone": phone, "code": _code(client, phone), "role": "owner"})
    assert r.status_code == 403, r.text
    assert "PLAN_REQUIRED" in r.text
    assert "id_token" not in r.text


def test_a_new_owner_who_chose_a_plan_signs_in(client):
    phone = new_phone()
    r = client.post("/api/v1/dev/otp/verify", json={"phone": phone, "code": _code(client, phone), "role": "owner", "plan": "starter"})
    assert r.status_code == 200 and r.json()["id_token"]


def test_an_owner_who_already_has_an_account_signs_in_without_a_plan(client, actor):
    owner = actor(roles=("owner",))
    r = client.post("/api/v1/dev/otp/verify", json={"phone": owner.phone, "code": _code(client, owner.phone), "role": "owner"})
    assert r.status_code == 200 and r.json()["id_token"]


def test_a_new_number_through_the_renter_door_or_no_door_is_not_held_back_here(client):
    for role in ("tenant", None):
        phone = new_phone()
        body = {"phone": phone, "code": _code(client, phone)}
        if role:
            body["role"] = role
        assert client.post("/api/v1/dev/otp/verify", json=body).status_code == 200


def test_the_session_step_also_refuses_to_create_an_account_for_a_planless_new_owner(client):
    phone = new_phone()
    tok = client.post("/api/v1/dev/otp/verify", json={"phone": phone, "code": _code(client, phone)}).json()["id_token"]
    h = {"Authorization": f"Bearer {tok}"}
    r = client.post("/api/v1/auth/session", headers=h, json={"role": "owner"})
    assert r.status_code == 403
    assert client.post("/api/v1/auth/session", headers=h, json={"role": "owner", "plan": "starter"}).status_code == 200
