"""Property rules: one registered owner per property, strong verification, one subscription per property, vacancy.
Small datasets only: two or three actors per test."""
from __future__ import annotations

import uuid
from datetime import date

import psycopg
import pytest

from .conftest import ADMIN, ensure_property, new_phone, pay_subscription, property_body
from .test_api_flows import END, accept_all, onboard
from .test_rls import as_app

TODAY = date.today()
M0 = TODAY.replace(day=1)


def owner_of(actor, name="Owner"):
    o = actor(roles=("owner",), name=name)
    pay_subscription(o)
    return o


def pay_for_account(owner, owner_account_id, plan="growth"):
    """Pay the plan of ONE specific account of this person (each property has its own)."""
    h = {"X-Owner-Account": owner_account_id}
    r = owner.post("/api/v1/subscription/checkout", json={"plan_code": plan, "idempotency_key": uuid.uuid4().hex}, headers=h)
    assert r.status_code == 200, r.text
    if r.json().get("free_month"):
        return                          # the first month of a plan is free: the account is already active, nothing to pay
    oid = r.json()["checkout"]["pay_url"].split("/")[-1].split("?")[0]
    r = owner.c.post(f"/api/v1/sandbox/pay/subscription/{oid}", content=b"outcome=success", headers={"content-type": "application/x-www-form-urlencoded"})
    assert "activated" in r.text, r.text


def code(r):
    return r.json()["error"]["code"]


# ───────── one registered owner per property ─────────
def test_the_same_property_cannot_be_registered_by_another_owner(actor):
    a, b = owner_of(actor, "Owner Alpha"), owner_of(actor, "Owner Beta")
    body = property_body(address="12, Market Rd., Anna Nagar", pincode="625020", proof_ref="PT-ALPHA-778899")
    assert a.post("/api/v1/owner/properties", json=body).status_code == 200
    # the same address typed differently (case, punctuation, abbreviation, "No.") is still the same property
    for variant in ("No. 12 market road anna nagar", "12 MARKET ROAD, ANNA NAGAR", "12-Market Road Anna Nagar 625020", "12 market rd anna nagar"):
        mine = property_body(address=variant, pincode="625020", proof_ref="PT-BETA-" + uuid.uuid4().hex[:8])
        r = b.post("/api/v1/owner/properties", json=mine)
        assert r.status_code == 409 and code(r) == "PROPERTY_ALREADY_REGISTERED", variant
        assert b.post("/api/v1/owner/properties/check", json=mine).status_code == 409        # the pre-check says so BEFORE paying
        assert "Alpha" not in r.text                                                          # never reveals who owns it
    # the same ownership document number cannot back a second property, however it is formatted
    other = property_body(address="99 Different Street, Anna Nagar", pincode="625020", proof_ref="pt alpha 778899")
    r = b.post("/api/v1/owner/properties", json=other)
    assert r.status_code == 409 and code(r) == "PROPERTY_PROOF_ALREADY_USED" and "Alpha" not in r.text
    # a different property with a different proof is fine
    assert b.post("/api/v1/owner/properties", json=property_body()).status_code == 200


def test_a_rejected_claim_frees_the_address_again(actor):
    a, b = owner_of(actor, "Owner Alpha"), owner_of(actor, "Owner Beta")
    body = property_body(address="7 Lake View Road", pincode="625010", proof_ref="PT-LAKE-445566")
    pid = a.post("/api/v1/owner/properties", json=body).json()["id"]
    assert b.post("/api/v1/owner/properties", json={**body, "proof_ref": "PT-LAKE-999999"}).status_code == 409
    assert a.c.post(f"/api/v1/admin/review/property/{pid}", json={"decision": "reject", "note": "document does not match"}, headers=ADMIN).status_code == 200
    assert b.post("/api/v1/owner/properties", json={**body, "proof_ref": "PT-LAKE-445566"}).status_code == 200     # address and proof are free again


def test_property_details_are_validated_strictly(actor):
    o = owner_of(actor)
    bad = [({"proof_ref": "000000"}, 422), ({"proof_ref": "AAAAAA"}, 422), ({"proof_ref": "123456"}, 422), ({"proof_ref": "ab"}, 422),
           ({"declare": False}, 422), ({"pincode": "12"}, 422), ({"pincode": None}, 422), ({"city": ""}, 422), ({"address": "x"}, 422),
           ({"proof_type": "made_up"}, 422)]
    for over, status in bad:
        r = o.post("/api/v1/owner/properties", json=property_body(**over))
        assert r.status_code == status, (over, r.text)
    assert o.get("/api/v1/owner/properties").json()["items"] == []                  # nothing half-stored
    assert o.post("/api/v1/owner/properties", json=property_body()).status_code == 200


def test_the_precheck_is_limited_so_it_cannot_probe_addresses(actor):
    o = owner_of(actor)
    codes = [o.post("/api/v1/owner/properties/check", json=property_body()).status_code for _ in range(12)]
    assert codes[:10] == [200] * 10 and codes[10:] == [429, 429]


# ───────── verification ─────────
def test_renters_need_a_verified_property_and_only_a_reviewer_can_verify(actor, sql):
    o = owner_of(actor)
    pid = ensure_property(o, verified=False)
    t = actor()
    attempt = {"property_id": pid, "unit_identifier": "V-1", "tenant_name": "Ravi", "tenant_mobile": t.phone, "monthly_rent": "1000",
               "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"}
    r = o.post("/api/v1/owner/tenancies", json=attempt)
    assert r.status_code == 409 and code(r) == "PROPERTY_NOT_VERIFIED"
    assert o.get("/api/v1/owner/properties").json()["items"][0]["verification_status"] == "submitted"
    # the signed-in database role cannot verify, rewrite or fake it, even directly
    owner_account = str(sql("SELECT owner_account_id FROM properties WHERE id = %s", pid)[0][0])
    with as_app({"app.user_id": str(o.id), "app.owner_ids": owner_account}) as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("UPDATE properties SET verification_status = 'verified' WHERE id = %s", (pid,))
    with as_app({"app.user_id": str(o.id), "app.owner_ids": owner_account}) as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("UPDATE system_flags SET value = 'on'")
    with as_app({"app.user_id": str(o.id), "app.owner_ids": owner_account}) as c:
        assert c.execute("SELECT rg_demo_verify_property(%s)", (pid,)).fetchone()[0] is False      # demo switch is off by default
    # the reviewer approves → renters can be added
    assert o.c.post(f"/api/v1/admin/review/property/{pid}", json={"decision": "approve"}, headers=ADMIN).status_code == 200
    assert o.post("/api/v1/owner/tenancies", json=attempt).status_code == 200
    # a verified property's address and proof can no longer be rewritten by the owner
    with as_app({"app.user_id": str(o.id), "app.owner_ids": owner_account}) as c:
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("UPDATE properties SET address = '1 Somewhere Else Road' WHERE id = %s", (pid,))
    # the review queue and the decision are not public
    assert o.c.get("/api/v1/admin/review").status_code == 404
    assert o.c.post(f"/api/v1/admin/review/property/{pid}", json={"decision": "approve"}).status_code == 404


def test_the_reviewer_sees_the_proof_and_possible_duplicates(actor):
    a, b = owner_of(actor, "Owner Alpha"), owner_of(actor, "Owner Beta")
    a.post("/api/v1/owner/properties", json=property_body(address="45 Temple Street Opp Bus Stand", pincode="625002", proof_ref="PT-TEMPLE-111222"))
    # very similar address, same pincode, different proof: allowed to submit but flagged for the reviewer
    b.post("/api/v1/owner/properties", json=property_body(address="45 Temple Street Opposite Bus Stand Madurai", pincode="625002", proof_ref="PT-TEMPLE-333444"))
    queue = a.c.get("/api/v1/admin/review", headers=ADMIN).json()["properties"]
    flagged = [p for p in queue if p["pincode"] == "625002" and p["near_duplicates"]]
    assert flagged and all(p["proof_ref"] and p["proof_type"] for p in queue)


# ───────── one subscription per property ─────────
@pytest.fixture
def business_covers_one_property(sql):
    """Business now covers 10 properties; this test is about a plan that covers ONE, so it is set to one for the length of the test."""
    sql("UPDATE subscription_plans SET max_properties = 1 WHERE code = 'business'")
    yield
    sql("UPDATE subscription_plans SET max_properties = 10 WHERE code = 'business'")


def test_a_plan_covers_one_property_more_properties_need_their_own_subscription(actor, business_covers_one_property):
    o = actor(roles=("owner",), name="Business Owner")
    pay_subscription(o, "business")                                   # a plan that covers ONE property
    ensure_property(o)
    r = o.post("/api/v1/owner/properties", json=property_body())
    assert r.status_code == 409 and code(r) == "PROPERTY_NEEDS_SUBSCRIPTION"
    # many shops/houses inside that property are fine (that is what the plan covers)
    for i in range(3):
        assert onboard(o, new_phone(), ident=f"B-{i}")["tenancy_id"]
    # another property = a new account for the same person: it starts with NO plan and cannot hold anything until paid
    w = o.post("/api/v1/owner/workspaces")
    assert w.status_code == 200 and w.json()["next"] == "choose_plan", w.text
    second = w.json()["owner_account_id"]
    h = {"X-Owner-Account": second}
    assert o.get("/api/v1/subscription", headers=h).json()["state"] == "none"
    assert o.post("/api/v1/owner/properties", json=property_body(), headers=h).status_code == 402              # unpaid: nothing can be added
    pay_for_account(o, second, "starter")                                                                       # pay for THIS property
    assert o.post("/api/v1/owner/properties", json=property_body(), headers=h).status_code == 200
    # the two properties are separate: own plan, own capacity, own renters
    mine = {w["owner_account_id"]: w for w in o.get("/api/v1/owner/workspaces").json()["items"]}
    assert len(mine) == 2 and {m["plan"] for m in mine.values()} == {"business", "starter"}
    assert sorted(m["units_capacity"] for m in mine.values()) == [10, 300]
    # the starter property is capped at 10 places, whatever the other plan allows
    pid2 = [m["property"]["id"] for m in mine.values() if m["plan"] == "starter"][0]
    o.c.post(f"/api/v1/admin/review/property/{pid2}", json={"decision": "approve"}, headers=ADMIN)
    def add(ident):
        return o.post("/api/v1/owner/tenancies", headers=h, json={"property_id": pid2, "unit_identifier": ident, "tenant_name": "Ravi",
                      "tenant_mobile": new_phone(), "monthly_rent": "1000", "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"})
    for n in range(1, 11):
        assert add(f"S-{n}").status_code == 200, n                      # ten places fit on the Rs 1 plan
    r = add("S-11")
    assert r.status_code == 409 and code(r) == "UNIT_CAPACITY_EXCEEDED"                                          # the eleventh does not
    # dashboards are per property
    assert o.get("/api/v1/owner/dashboard", headers=h).json()["metrics"]["units"] == 10


def test_adding_another_property_account_is_controlled(actor):
    o = owner_of(actor)
    assert o.post("/api/v1/owner/workspaces").status_code == 409                  # the current account has no property yet: use it first
    ensure_property(o)
    ids = []
    for _ in range(2):
        r = o.post("/api/v1/owner/workspaces")
        assert r.status_code == 200
        ids.append(r.json()["owner_account_id"])
    r = o.post("/api/v1/owner/workspaces")                                        # two empty ones already waiting: finish them first
    assert r.status_code == 409
    co = actor(roles=("owner",))                                                  # someone else cannot create accounts for this person
    assert co.post("/api/v1/owner/workspaces", headers={"X-Owner-Account": ids[0]}).status_code in (403, 404)
    # the reviewed owner details are copied, not asked again
    assert o.get("/api/v1/owner/verification", headers={"X-Owner-Account": ids[0]}).json()["status"] in ("submitted", "verified")


# ───────── vacant units ─────────
def test_a_unit_becomes_vacant_when_the_renter_leaves_and_is_easy_to_refill(actor):
    o = owner_of(actor)
    old, new = actor(), actor()
    tid = onboard(o, old.phone, ident="V-7")["tenancy_id"]; accept_all(old)
    units = o.get("/api/v1/owner/units").json()["items"]
    assert [u["vacant"] for u in units] == [False] and o.get("/api/v1/owner/units", params={"vacant": "true"}).json()["items"] == []
    end = o.post(f"/api/v1/owner/tenancies/{tid}/end", params={"end_date": TODAY.isoformat()})
    assert end.status_code == 200
    vac = o.get("/api/v1/owner/units", params={"vacant": "true"}).json()["items"]
    assert len(vac) == 1 and vac[0]["identifier"] == "V-7" and vac[0]["vacant"] is True and vac[0]["vacant_since"] == TODAY.isoformat()
    assert vac[0]["last_rent_paise"] == 1000000
    assert o.get("/api/v1/owner/properties").json()["items"][0]["vacant_units"] == 1
    # one call fills it: pick the vacant unit, give the new renter's details
    r = o.post("/api/v1/owner/tenancies", json={"unit_id": vac[0]["id"], "tenant_name": "New Renter", "tenant_mobile": new.phone,
                                                "monthly_rent": "12000", "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"})
    assert r.status_code == 200, r.text
    accept_all(new)
    assert o.get("/api/v1/owner/units", params={"vacant": "true"}).json()["items"] == []
    assert o.get("/api/v1/owner/properties").json()["items"][0]["vacant_units"] == 0
    # someone else's vacant unit cannot be filled
    stranger = owner_of(actor, "Stranger")
    ensure_property(stranger)
    t = stranger.post("/api/v1/owner/tenancies", json={"unit_id": vac[0]["id"], "tenant_name": "Xavier", "tenant_mobile": new_phone(), "monthly_rent": "1",
                                                       "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"})
    assert t.status_code == 404, t.text
