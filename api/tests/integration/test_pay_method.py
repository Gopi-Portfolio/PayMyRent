"""How the owner receives rent from each tenant: UPI direct (free), online, or cash. Requires PostgreSQL."""
from __future__ import annotations

import uuid
from datetime import date

from .conftest import ensure_property, pay_subscription
from .test_api_flows import M0, TODAY, accept_all

UPI = "owner.test@okhdfcbank"


def _tenancy(owner, tenant, **extra):
    r = owner.post("/api/v1/owner/tenancies", json={
        "property_id": ensure_property(owner), "unit_identifier": f"S-{uuid.uuid4().hex[:4]}", "tenant_name": "Ravi Kumar",
        "tenant_mobile": tenant.phone, "monthly_rent": "10000", "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "0", **extra})
    return r


def _report(tenant, tid, amount="4000", ref="UTR123456789", key=None):
    return tenant.post(f"/api/v1/tenant/tenancies/{tid}/payments/manual-transfer", json={
        "amount": amount, "paid_on": TODAY.isoformat(), "reference": ref, "idempotency_key": key or uuid.uuid4().hex})


def test_upi_choice_needs_a_code_the_first_time_then_is_remembered(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t1, t2 = actor(), actor()
    no_code = _tenancy(owner, t1, pay_method="upi", pay_upi_id=UPI)
    assert no_code.status_code == 403 and no_code.json()["error"]["details"].get("otp_required")      # a new UPI ID sends money somewhere new
    bad = _tenancy(owner, t1, pay_method="upi", pay_upi_id="not a upi id", otp_code=owner.action_code("payout"))
    assert bad.status_code == 422 or bad.status_code == 400
    ok = _tenancy(owner, t1, pay_method="upi", pay_upi_id=UPI.upper(), otp_code=owner.action_code("payout"))
    assert ok.status_code == 200, ok.text
    assert owner.get("/api/v1/owner/upi-ids").json()["upi_ids"] == [UPI]                  # stored lower-case
    again = _tenancy(owner, t2, pay_method="upi", pay_upi_id=UPI)                          # same ID: no new code
    assert again.status_code == 200, again.text
    assert owner.get("/api/v1/owner/upi-ids").json()["default_upi_id"] == UPI              # the first ID given is saved in the profile
    nobody = actor(roles=("owner",))
    pay_subscription(nobody)
    missing = _tenancy(nobody, actor(), pay_method="upi")                                  # no profile UPI ID yet and none given
    assert missing.status_code in (400, 422)
    cash = _tenancy(owner, actor(), pay_method="cash", pay_upi_id=UPI)
    assert cash.status_code == 200
    d = owner.get(f"/api/v1/owner/tenancies/{cash.json()['tenancy_id']}").json()["tenancy"]
    assert d["pay_method"] == "cash" and d["pay_upi_id"] is None                            # a UPI ID is kept only for the UPI choice


def test_tenant_sees_upi_and_online_checkout_is_closed(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = _tenancy(owner, tenant, pay_method="upi", pay_upi_id=UPI, otp_code=owner.action_code("payout")).json()["tenancy_id"]
    accept_all(tenant)
    rental = next(r for r in tenant.get("/api/v1/tenant/rentals").json()["items"] if r["id"] == tid)
    assert rental["pay_method"] == "upi" and rental["pay_upi_id"] == UPI
    co = tenant.post(f"/api/v1/tenant/tenancies/{tid}/payments/checkout", json={"amount": "1000", "idempotency_key": uuid.uuid4().hex})
    assert co.status_code != 200 and co.json()["error"]["code"] == "PAYMENTS_UNAVAILABLE"


def test_upi_report_confirm_and_reject(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = _tenancy(owner, tenant, pay_method="upi", pay_upi_id=UPI, otp_code=owner.action_code("payout")).json()["tenancy_id"]
    accept_all(tenant)
    due = int(tenant.get(f"/api/v1/tenancies/{tid}/bill").json()["summary"]["total_due_paise"])
    assert due == 1000000
    r = _report(tenant, tid, "4000", "UTR111111")
    assert r.status_code == 200 and r.json()["status"] == "pending"
    assert int(tenant.get(f"/api/v1/tenancies/{tid}/bill").json()["summary"]["total_due_paise"]) == due        # nothing changes until the owner confirms
    pend = owner.get("/api/v1/owner/payments/pending-transfers").json()["items"]
    assert [(p["reference"], p["amount_paise"]) for p in pend] == [("UTR111111", 400000)]
    # the same reference cannot be used again; reports waiting for the owner count against what is due
    assert _report(tenant, tid, "100", "utr111111").status_code in (400, 422)
    assert _report(tenant, tid, "7000", "UTR222222").status_code in (400, 422)
    second = _report(tenant, tid, "6000", "UTR333333")
    assert second.status_code == 200
    # confirming credits the dues and gives a receipt; rejecting changes nothing
    ok = owner.post(f"/api/v1/owner/payments/{r.json()['id']}/confirm-transfer")
    assert ok.status_code == 200 and ok.json()["status"] == "confirmed" and ok.json()["receipt_number"]
    no = owner.post(f"/api/v1/owner/payments/{second.json()['id']}/reject-transfer", json={"reason": "not received"})
    assert no.status_code == 200 and no.json()["status"] == "failed"
    assert int(tenant.get(f"/api/v1/tenancies/{tid}/bill").json()["summary"]["total_due_paise"]) == due - 400000
    assert owner.get("/api/v1/owner/payments/pending-transfers").json()["items"] == []
    assert owner.post(f"/api/v1/owner/payments/{second.json()['id']}/confirm-transfer").status_code != 200      # a closed report cannot be confirmed
    # a rejected reference can be reported again (it was never received)
    assert _report(tenant, tid, "6000", "UTR333333").status_code == 200


def test_changing_the_payee_needs_a_code_and_tells_the_tenant(actor, sql):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = _tenancy(owner, tenant, pay_method="online").json()["tenancy_id"]
    accept_all(tenant)
    other = "new.owner@oksbi"
    assert owner.put(f"/api/v1/owner/tenancies/{tid}/payment-method", json={"method": "upi", "upi_id": other}).status_code == 403
    ok = owner.put(f"/api/v1/owner/tenancies/{tid}/payment-method", json={"method": "upi", "upi_id": other, "otp_code": owner.action_code("payout")})
    assert ok.status_code == 200 and ok.json() == {"pay_method": "upi", "pay_upi_id": None, "follows_default": False, "effective_upi_id": other}   # first ID becomes the profile one
    assert sql("SELECT count(*) FROM notification_events WHERE template = 'pay_method_changed' AND payload->>'owner' IS NOT NULL")[0][0] >= 1
    assert owner.put(f"/api/v1/owner/tenancies/{tid}/payment-method", json={"method": "cash"}).json()["pay_method"] == "cash"


def test_a_stranger_cannot_change_or_read_another_owners_choice(actor):
    owner, stranger = actor(roles=("owner",)), actor(roles=("owner",))
    pay_subscription(owner)
    tid = _tenancy(owner, actor(), pay_method="cash").json()["tenancy_id"]
    assert stranger.put(f"/api/v1/owner/tenancies/{tid}/payment-method", json={"method": "cash"}).status_code == 404
    assert stranger.get("/api/v1/owner/payments/pending-transfers").json()["items"] == []


def test_profile_upi_is_the_default_and_a_tenant_can_have_its_own(actor, sql):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t1, t2, t3 = actor(), actor(), actor()
    assert owner.put("/api/v1/owner/upi-default", json={"upi_id": UPI}).status_code == 403               # needs the code
    assert owner.put("/api/v1/owner/upi-default", json={"upi_id": "bad id", "otp_code": owner.action_code("payout")}).status_code in (400, 422)
    assert owner.put("/api/v1/owner/upi-default", json={"upi_id": UPI, "otp_code": owner.action_code("payout")}).json() == {"upi_id": UPI}
    # tenants set to UPI need no ID typed: they follow the profile one
    a = _tenancy(owner, t1, pay_method="upi").json()["tenancy_id"]
    b = _tenancy(owner, t2, pay_method="upi", pay_upi_id="shop.second@oksbi", otp_code=owner.action_code("payout")).json()["tenancy_id"]
    c = _tenancy(owner, t3, pay_method="online").json()["tenancy_id"]
    for t in (t1, t2, t3):
        accept_all(t)
    seen = {r["id"]: r for u in (t1, t2, t3) for r in u.get("/api/v1/tenant/rentals").json()["items"]}
    assert seen[a]["pay_upi_id"] == UPI and seen[b]["pay_upi_id"] == "shop.second@oksbi"
    assert seen[c]["pay_method"] == "online" and seen[c]["pay_mode"] == "upi" and seen[c]["pay_upi_id"] == UPI   # the sandbox checkout is a demo: it is not offered, UPI is
    # changing the profile ID moves every tenant that follows it (not the one with its own) and tells them
    new = "moved.owner@okicici"
    before = sql("SELECT count(*) FROM notification_events WHERE template = 'pay_method_changed'")[0][0]
    assert owner.put("/api/v1/owner/upi-default", json={"upi_id": new, "otp_code": owner.action_code("payout")}).status_code == 200
    seen = {r["id"]: r for u in (t1, t2) for r in u.get("/api/v1/tenant/rentals").json()["items"]}
    assert seen[a]["pay_upi_id"] == new and seen[b]["pay_upi_id"] == "shop.second@oksbi"
    assert sql("SELECT count(*) FROM notification_events WHERE template = 'pay_method_changed'")[0][0] > before
    d = owner.get(f"/api/v1/owner/tenancies/{a}").json()
    assert d["default_upi_id"] == new and d["tenancy"]["pay_upi_id"] is None
    # giving this tenant the profile ID again clears its own one
    back = owner.put(f"/api/v1/owner/tenancies/{b}/payment-method", json={"method": "upi", "upi_id": new})
    assert back.status_code == 200 and back.json()["pay_upi_id"] is None and back.json()["effective_upi_id"] == new


def test_one_choice_for_every_tenant_without_one(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    old1, old2, chosen = actor(), actor(), actor()
    a = _tenancy(owner, old1).json()["tenancy_id"]                        # added before the choice existed: no method
    b = _tenancy(owner, old2).json()["tenancy_id"]
    c = _tenancy(owner, chosen, pay_method="cash").json()["tenancy_id"]
    assert owner.get("/api/v1/owner/upi-ids").json()["last_pay_method"] == "cash"
    code = owner.action_code("payout")
    r = owner.put("/api/v1/owner/payment-method/unset", json={"method": "upi", "upi_id": UPI, "otp_code": code})
    assert r.status_code == 200 and r.json()["updated"] == 2
    got = {t: owner.get(f"/api/v1/owner/tenancies/{t}").json()["tenancy"]["pay_method"] for t in (a, b, c)}
    assert got == {a: "upi", b: "upi", c: "cash"}                          # the tenant who already chose is left alone
    assert owner.put("/api/v1/owner/payment-method/unset", json={"method": "upi"}).json()["updated"] == 0
    assert all(i["pay_method"] for i in owner.get("/api/v1/owner/tenancies?status=live").json()["items"])


def test_renter_is_never_sent_to_the_demo_checkout(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t1, t2 = actor(), actor()
    a = _tenancy(owner, t1).json()["tenancy_id"]                              # no choice yet, and the owner has no UPI ID
    accept_all(t1)
    r = next(x for x in t1.get("/api/v1/tenant/rentals").json()["items"] if x["id"] == a)
    assert r["pay_mode"] == "none" and r["pay_upi_id"] is None
    owner.put("/api/v1/owner/upi-default", json={"upi_id": UPI, "otp_code": owner.action_code("payout")})
    b = _tenancy(owner, t2).json()["tenancy_id"]                              # still no choice, but the owner now has a UPI ID
    accept_all(t2)
    r = next(x for x in t2.get("/api/v1/tenant/rentals").json()["items"] if x["id"] == b)
    assert r["pay_mode"] == "upi" and r["pay_upi_id"] == UPI
    assert owner.get("/api/v1/owner/upi-ids").json()["online_available"] is False


def test_profile_default_method_is_followed_unless_a_tenant_has_their_own(actor, sql):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t1, t2, t3 = actor(), actor(), actor()
    a = _tenancy(owner, t1).json()["tenancy_id"]                                              # no choice of its own
    assert owner.put("/api/v1/owner/pay-default", json={"method": "online"}).status_code in (400, 422)      # no live provider: cannot be the default
    assert owner.put("/api/v1/owner/pay-default", json={"method": "upi"}).status_code in (400, 422)         # UPI needs an ID the first time
    ok = owner.put("/api/v1/owner/pay-default", json={"method": "upi", "upi_id": UPI, "otp_code": owner.action_code("payout")})
    assert ok.status_code == 200 and owner.get("/api/v1/owner/upi-ids").json()["default_upi_id"] == UPI     # the first UPI ID also becomes the profile one
    assert owner.get("/api/v1/owner/upi-ids").json()["default_pay_method"] == "upi"
    b = _tenancy(owner, t2, pay_method="upi").json()["tenancy_id"]                            # the same as the default: stored as "follows it"
    c = _tenancy(owner, t3, pay_method="cash").json()["tenancy_id"]                           # an exception chosen for this tenant
    for t in (t1, t2, t3):
        accept_all(t)
    stored = {x: sql("SELECT pay_method FROM tenancies WHERE id = %s", x)[0][0] for x in (a, b, c)}
    assert stored == {a: None, b: None, c: "cash"}
    assert [r["effective_pay_method"] for r in owner.get("/api/v1/owner/tenancies?status=live").json()["items"] if r["id"] == a] == ["upi"]
    assert _rental(t1, a)["pay_mode"] == "upi" and _rental(t2, b)["pay_upi_id"] == UPI and _rental(t3, c)["pay_mode"] == "cash"
    # moving the default moves the tenants that follow it (and tells them), not the one with its own choice
    before = sql("SELECT count(*) FROM notification_events WHERE template = 'pay_method_changed'")[0][0]
    assert owner.put("/api/v1/owner/pay-default", json={"method": "cash"}).status_code == 200
    assert _rental(t1, a)["pay_mode"] == "cash" and _rental(t2, b)["pay_mode"] == "cash" and _rental(t3, c)["pay_mode"] == "cash"
    assert sql("SELECT count(*) FROM notification_events WHERE template = 'pay_method_changed'")[0][0] > before
    assert owner.get(f"/api/v1/owner/tenancies/{a}").json()["effective_pay_method"] == "cash"
    # a tenant cannot change it, and the profile UPI ID cannot be swapped through this call
    assert t1.put("/api/v1/owner/pay-default", json={"method": "cash"}).status_code in (401, 403, 404)
    assert owner.put("/api/v1/owner/pay-default", json={"method": "upi", "upi_id": "other@oksbi"}).status_code in (400, 422)


def _rental(t, tid):
    return next(r for r in t.get("/api/v1/tenant/rentals").json()["items"] if r["id"] == tid)
