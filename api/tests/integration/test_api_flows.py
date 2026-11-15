"""End-to-end API scenarios from TEST_PLAN.md (numbers in brackets). Requires PostgreSQL."""
from __future__ import annotations

import io
import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

from app.domain.excel_import import build_template
from app.domain.signatures import hmac_sha256_hex

from .conftest import ADMIN, ensure_property, new_phone, pay_subscription, property_body

TODAY = date.today()
M0 = TODAY.replace(day=1)
END = (M0 + timedelta(days=730)).isoformat()      # a new rental must carry an end date


def onboard(owner, tenant_phone, rent="10000", ident=None, deposit="1000"):
    pid = ensure_property(owner)                      # the owner's one registered + verified property
    r = owner.post("/api/v1/owner/tenancies", json={
        "property_id": pid, "unit_identifier": ident or f"S-{uuid.uuid4().hex[:4]}",
        "tenant_name": "Ravi Kumar", "tenant_mobile": tenant_phone, "monthly_rent": rent, "due_day": 5,
        "start_date": M0.isoformat(), "end_date": END, "security_deposit": deposit})
    assert r.status_code == 200, r.text
    return r.json()


def accept_all(tenant):
    for inv in tenant.get("/api/v1/tenant/invitations").json()["items"]:
        assert tenant.post(f"/api/v1/tenant/invitations/{inv['id']}/accept").status_code == 200


# [1] public pricing, roles, tenant free, paid activation exactly once
def test_public_plans_are_exact(client):
    plans = client.get("/api/v1/plans").json()
    assert [(p["code"], p["price_paise"], p["max_units"], p["ai_monthly_tokens"]) for p in plans["plans"]] == [
        ("starter", 1000, 10, 0), ("growth", 5000, 100, 100000), ("business", 10000, 250, 500000), ("max", 100000, 1000, 1000000)]
    by = {p["code"]: p for p in plans["plans"]}
    assert [by[c]["max_properties"] for c in ("starter", "growth", "business", "max")] == [1, 5, 10, 100]
    # launch price (charged) and regular price (shown crossed out); the saving is worked out by the server from the two
    assert by["starter"]["regular_price_paise"] is None and by["starter"]["saving_percent"] is None
    assert [(by[c]["regular_price_display"], by[c]["saving_percent"]) for c in ("growth", "business", "max")] == [("₹65", 23), ("₹150", 33), ("₹2,000", 50)]
    assert by["growth"]["saving_paise"] == 1500 and by["max"]["saving_paise"] == 100000
    assert plans["paid_by"] == "owner" and plans["tenant_access"] == "free"


def test_owner_activation_only_via_verified_webhook(actor, sql):
    owner = actor(roles=("owner",))
    assert owner.get("/api/v1/subscription").json()["state"] == "none"
    r = owner.post("/api/v1/owner/properties", json=property_body())
    assert r.status_code == 402                                        # unpaid owner blocked
    out = owner.post("/api/v1/subscription/checkout", json={"plan_code": "growth", "idempotency_key": "k-" + uuid.uuid4().hex}).json()
    oid = out["checkout"]["pay_url"].split("/")[-1].split("?")[0]
    # forged / unsigned webhook is rejected and does not activate
    body = json.dumps({"id": "evt1", "event": "payment.captured", "payload": {"payment": {"entity": {
        "id": "pay_x", "order_id": oid, "amount": 5000}}}}).encode()
    assert owner.c.post("/api/v1/webhooks/payments/subscription", content=body, headers={"x-razorpay-signature": "bad"}).status_code == 403
    assert owner.get("/api/v1/subscription").json()["state"] == "none"
    # correctly signed → activates; replay → duplicate, still one subscription
    sig = hmac_sha256_hex("sandbox-sub-webhook-secret", body)
    assert owner.c.post("/api/v1/webhooks/payments/subscription", content=body, headers={"x-razorpay-signature": sig}).json()["result"] == "activated"
    assert owner.c.post("/api/v1/webhooks/payments/subscription", content=body, headers={"x-razorpay-signature": sig}).json()["result"] == "duplicate_event"
    assert owner.get("/api/v1/subscription").json()["state"] == "active"
    assert sql("SELECT count(*) FROM owner_subscriptions s JOIN owner_accounts a ON a.id = s.owner_account_id JOIN users u ON u.id = a.primary_user_id WHERE u.id = %s", owner.id)[0][0] == 1


def test_both_role_tenant_view_free_before_owner_payment(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    both = actor(roles=("owner", "tenant"))
    onboard(owner, both.phone)
    accept_all(both)
    assert len(both.get("/api/v1/tenant/rentals").json()["items"]) == 1   # tenant side works unpaid
    assert both.get("/api/v1/subscription").json()["state"] == "none"     # owner side still unpaid
    assert both.post("/api/v1/owner/properties", json=property_body()).status_code == 402


# [2] invitation gating
def test_tenant_sees_nothing_until_accepting(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    t = onboard(owner, tenant.phone)
    assert tenant.get("/api/v1/tenant/rentals").json()["items"] == []
    invs = tenant.get("/api/v1/tenant/invitations").json()["items"]
    assert len(invs) == 1 and set(invs[0]) == {"id", "owner_name", "unit", "created_at", "owner_verification", "your_mobile"}   # no rent, balances, address or city
    assert tenant.get(f"/api/v1/tenancies/{t['tenancy_id']}/bill").status_code == 404
    accept_all(tenant)
    assert tenant.get(f"/api/v1/tenancies/{t['tenancy_id']}/bill").status_code == 200


def test_owner_can_edit_rent_due_day_and_deposit(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t = onboard(owner, actor().phone)
    tid = t["tenancy_id"]
    d = owner.get(f"/api/v1/owner/tenancies/{tid}").json()
    r = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": d["tenancy"]["version"], "monthly_rent": "12500", "due_day": 7,
                                                           "grace_days": 3, "security_deposit": "50000"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["current_rent_paise"] == 1250000 and out["tenancy"]["due_day"] == 7 and out["tenancy"]["deposit_agreed_paise"] == 5000000
    stale = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": d["tenancy"]["version"], "due_day": 9})
    assert stale.status_code == 409 or stale.status_code == 400, stale.text   # edits are version-checked


def test_earlier_unpaid_months_show_as_dues(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    start = date(TODAY.year - 1, 12, 1) if TODAY.month <= 2 else date(TODAY.year, TODAY.month - 2, 1)
    r = owner.post("/api/v1/owner/tenancies", json={
        "property_id": ensure_property(owner), "unit_identifier": f"S-{uuid.uuid4().hex[:4]}", "tenant_name": "Ravi Kumar",
        "tenant_mobile": tenant.phone, "monthly_rent": "10000", "due_day": 5, "start_date": start.isoformat(), "security_deposit": "1000", "end_date": END})
    assert r.status_code == 200, r.text
    tid = r.json()["tenancy_id"]
    accept_all(tenant)                                             # accepting bills every month since the start
    bill = tenant.get(f"/api/v1/tenancies/{tid}/bill").json()
    assert int(bill["summary"]["arrears_paise"]) == 2 * 1000000 and int(bill["summary"]["total_due_paise"]) == 3 * 1000000
    # owner generating the current bill is idempotent and never duplicates earlier months
    again = owner.post(f"/api/v1/owner/tenancies/{tid}/invoices?month={M0.isoformat()}").json()
    assert int(again["summary"]["total_due_paise"]) == 3 * 1000000


def test_moving_the_end_date_updates_the_dues(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    start = date(TODAY.year - 1, 12, 1) if TODAY.month <= 2 else date(TODAY.year, TODAY.month - 2, 1)
    r = owner.post("/api/v1/owner/tenancies", json={
        "property_id": ensure_property(owner), "unit_identifier": f"E-{uuid.uuid4().hex[:4]}", "tenant_name": "Ravi Kumar",
        "tenant_mobile": tenant.phone, "monthly_rent": "10000", "due_day": 5, "start_date": start.isoformat(), "security_deposit": "1000", "end_date": END})
    assert r.status_code == 200, r.text
    tid = r.json()["tenancy_id"]
    accept_all(tenant)
    total = lambda: int(tenant.get(f"/api/v1/tenancies/{tid}/bill").json()["summary"]["total_due_paise"])
    assert total() == 3_000_000                                                     # three months billed so far

    def move_end(d):
        v = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
        res = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": v, "end_date": d.isoformat()})
        assert res.status_code == 200, res.text

    second = (start.replace(day=28) + timedelta(days=5)).replace(day=1)             # first day of the 2nd month
    dim = ((second.replace(day=28) + timedelta(days=5)).replace(day=1) - second).days
    move_end(second + timedelta(days=14))                                           # ends on the 15th of the 2nd month
    assert total() == 1_000_000 + round(1_000_000 * 15 / dim)                       # month 3 credited back, month 2 pro-rated
    move_end(date.fromisoformat(END))                                               # extended again
    assert total() == 3_000_000                                                     # the dues are back at once


def test_dashboard_boxes_have_detail_rows(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    t = onboard(owner, tenant.phone)
    accept_all(tenant)
    pend = owner.get("/api/v1/owner/dashboard/pending").json()
    assert [i["tenancy_id"] for i in pend["items"]] == [t["tenancy_id"]] and int(pend["items"][0]["amount_paise"]) == 1000000
    assert owner.get("/api/v1/owner/dashboard/units").json()["items"][0]["tenant_name"] == "Ravi Kumar"
    owner.post(f"/api/v1/owner/tenancies/{t['tenancy_id']}/payments/cash", json={"amount": "4000", "paid_on": TODAY.isoformat(), "idempotency_key": uuid.uuid4().hex})
    col = owner.get("/api/v1/owner/dashboard/collected").json()
    assert len(col["items"]) == 1 and int(col["total_paise"]) == 400000
    assert owner.get("/api/v1/owner/dashboard/nonsense").status_code == 422


# [4][14] isolation: two owners, a tenant of both, a Both user
def test_cross_owner_isolation(actor):
    a, b = actor(roles=("owner",), name="Owner Alpha"), actor(roles=("owner",), name="Owner Beta")
    pay_subscription(a)
    pay_subscription(b)
    tenant = actor(roles=("owner", "tenant"))
    ta = onboard(a, tenant.phone)["tenancy_id"]
    tb = onboard(b, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    assert b.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404
    assert b.post(f"/api/v1/owner/tenancies/{ta}/payments/cash", json={"amount": "1", "idempotency_key": "x" * 10}).status_code == 404
    assert b.get(f"/api/v1/tenancies/{ta}/bill").status_code == 404
    assert tenant.get(f"/api/v1/owner/tenancies/{ta}").status_code in (402, 403, 404)
    assert tenant.post(f"/api/v1/owner/tenancies/{ta}/payments/cash", json={"amount": "1", "idempotency_key": "y" * 10}).status_code in (403, 404)
    # forged owner header
    assert b.get("/api/v1/owner/tenancies", headers={"X-Owner-Account": str(uuid.uuid4())}).status_code == 404
    rentals = tenant.get("/api/v1/tenant/rentals").json()["items"]
    assert {r["id"] for r in rentals} == {ta, tb}
    assert len({r["owner_name"] for r in rentals}) == 2
    assert all(t["id"] not in (ta,) for t in b.get("/api/v1/owner/tenancies").json()["items"])


# [8] cash partial payments and carry-forward
def test_cash_partial_and_dispute(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    p = owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "7000", "idempotency_key": "cash-" + tid}).json()
    assert p["verification"] == "owner_recorded" and p["balance_after_paise"] == 300000 and p["receipt_number"]
    again = owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "7000", "idempotency_key": "cash-" + tid}).json()
    assert again["id"] == p["id"]                                       # retry doesn't double-record
    bill = tenant.get(f"/api/v1/tenancies/{tid}/bill").json()
    assert bill["summary"]["total_due_paise"] == 300000
    r = tenant.post(f"/api/v1/tenant/payments/{p['id']}/ack", json={"response": "disputed", "reason": "I paid 7500"})
    assert r.status_code == 200 and r.json()["tenant_ack"] == "disputed"
    assert owner.get("/api/v1/owner/disputes").json()["items"][0]["reason"] == "I paid 7500"


# [9] gateway rent: signed webhook, exactly once, no crossover with the subscription webhook
def test_rent_gateway_and_purpose_separation(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    pay = tenant.post(f"/api/v1/tenant/tenancies/{tid}/payments/checkout", json={"amount": "4000", "idempotency_key": "chk-" + tid}).json()
    assert pay["status"] == "pending"
    order = pay["checkout"]["pay_url"].split("/")[-1].split("?")[0]
    body = json.dumps({"id": "evt-rent-1", "event": "payment.captured", "payload": {"payment": {"entity": {
        "id": "pay_r1", "order_id": order, "amount": 400000}}}}).encode()
    # a rent order delivered to the SUBSCRIPTION endpoint (with that endpoint's secret) does nothing
    r = tenant.c.post("/api/v1/webhooks/payments/subscription", content=body,
                      headers={"x-razorpay-signature": hmac_sha256_hex("sandbox-sub-webhook-secret", body)})
    assert r.json()["result"] == "unknown_order"
    sig = hmac_sha256_hex("sandbox-rent-webhook-secret", body)
    assert tenant.c.post("/api/v1/webhooks/payments/rent", content=body, headers={"x-razorpay-signature": sig}).json()["result"] == "confirmed"
    body2 = body.replace(b"evt-rent-1", b"evt-rent-2")                  # same payment, new event id
    sig2 = hmac_sha256_hex("sandbox-rent-webhook-secret", body2)
    assert tenant.c.post("/api/v1/webhooks/payments/rent", content=body2, headers={"x-razorpay-signature": sig2}).json()["result"] == "already_confirmed"
    assert tenant.get(f"/api/v1/payments/{pay['id']}").json()["balance_after_paise"] == 600000


# bulk rent payment: one renter, two owners, one button; amounts are the server's, never the app's
def test_bulk_checkout_pays_each_rental_in_full(actor):
    o1, o2 = actor(roles=("owner",)), actor(roles=("owner",))
    pay_subscription(o1)
    pay_subscription(o2)
    tenant = actor()
    t1 = onboard(o1, tenant.phone)["tenancy_id"]
    t2 = onboard(o2, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    for o, t in ((o1, t1), (o2, t2)):
        o.post(f"/api/v1/owner/tenancies/{t}/invoices", params={"month": M0.isoformat()})
    due = {t: tenant.get(f"/api/v1/tenancies/{t}/bill").json()["summary"]["total_due_paise"] for t in (t1, t2)}
    assert all(v > 0 for v in due.values())
    body = {"items": [{"tenancy_id": t, "idempotency_key": "bulk-" + t} for t in (t1, t2)]}
    r = tenant.post("/api/v1/tenant/payments/checkout-bulk", json=body)
    assert r.status_code == 200
    got = {i["tenancy_id"]: i for i in r.json()["items"]}
    assert all(got[t]["error"] is None and got[t]["payment"]["amount_paise"] == due[t] for t in (t1, t2))
    assert got[t1]["payment"]["id"] != got[t2]["payment"]["id"]
    again = tenant.post("/api/v1/tenant/payments/checkout-bulk", json=body).json()["items"]
    assert [i["payment"]["id"] for i in again] == [got[t1]["payment"]["id"], got[t2]["payment"]["id"]]   # retry never double-charges
    dup = {"items": [body["items"][0], body["items"][0]]}
    assert tenant.post("/api/v1/tenant/payments/checkout-bulk", json=dup).status_code == 422


# reports and statements download as Excel and PDF, with the sign-in token, for owner and renter
def test_reports_and_statements_download(actor):
    import io
    from openpyxl import load_workbook
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant, stranger = actor(), actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    for kind in ("collected", "pending", "overdue", "units"):
        x = owner.get(f"/api/v1/owner/dashboard/{kind}/export", params={"format": "xlsx"})
        assert x.status_code == 200 and "spreadsheetml" in x.headers["content-type"], (kind, x.text[:200])
        assert load_workbook(io.BytesIO(x.content)).worksheets[0]["A1"].value.startswith("RentMeezy")
        p = owner.get(f"/api/v1/owner/dashboard/{kind}/export", params={"format": "pdf"})
        assert p.status_code == 200 and p.content[:4] == b"%PDF", (kind, p.text[:200])
    for who in (owner, tenant):
        for fmt in ("xlsx", "pdf"):
            r = who.get(f"/api/v1/tenancies/{tid}/statement", params={"format": fmt})
            assert r.status_code == 200, (fmt, r.text[:200])
    wb = load_workbook(io.BytesIO(tenant.get(f"/api/v1/tenancies/{tid}/statement", params={"format": "xlsx"}).content))
    assert wb.sheetnames == ["Months", "Payments"] and wb["Months"].max_row >= 6
    assert stranger.get(f"/api/v1/tenancies/{tid}/statement", params={"format": "xlsx"}).status_code in (403, 404)
    assert owner.c.get(f"/api/v1/tenancies/{tid}/statement", params={"format": "pdf"}).status_code == 401      # a plain browser link has no token
    for fmt in ("xlsx", "pdf"):
        assert tenant.get("/api/v1/tenant/report/export", params={"format": fmt}).status_code == 200
    assert load_workbook(io.BytesIO(tenant.get("/api/v1/tenant/report/export").content)).sheetnames == ["Rentals", "Payments"]


# the renter is told at once when the owner changes rent / advance / due day, or records cash
def test_renter_is_told_about_changes(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    assert tenant.get("/api/v1/tenant/updates").json()["items"] == []
    accept_all(tenant)
    version = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
    r = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": version, "monthly_rent": "12000", "security_deposit": "50000", "due_day": 7})
    assert r.status_code == 200, r.text
    items = tenant.get("/api/v1/tenant/updates").json()["items"]
    assert len(items) == 1 and items[0]["template"] == "terms_changed", items
    assert "rent" in items[0]["text"] and "₹12,000" in items[0]["text"] and "advance" in items[0]["text"] and "due day" in items[0]["text"]
    v2 = r.json()["tenancy"]["version"]
    owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": v2, "monthly_rent": "12000"})            # nothing really changed: no message
    assert len(tenant.get("/api/v1/tenant/updates").json()["items"]) == 1
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "1000", "idempotency_key": "cash-note-1"}).status_code == 200
    kinds = [i["template"] for i in tenant.get("/api/v1/tenant/updates").json()["items"]]
    assert kinds[0] == "cash_recorded" and "terms_changed" in kinds
    assert owner.get("/api/v1/tenant/updates").json()["items"] == []                                       # an owner never sees a renter's updates


# one address, one tenant until they are removed or vacate (however the unit is spelled)
def test_address_has_one_tenant_at_a_time(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t1, t2 = actor(), actor()
    pid = ensure_property(owner)

    def add(phone, ident):
        return owner.post("/api/v1/owner/tenancies", json={"property_id": pid, "unit_identifier": ident, "tenant_name": "Ravi Kumar", "tenant_mobile": phone,
                                                           "monthly_rent": "10000", "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END})
    first = add(t1.phone, "S-01")
    assert first.status_code == 200, first.text
    for spelling in ("S-01", "s-01", "S 01", "S01"):                      # still invited: the address is already offered to someone
        r = add(t2.phone, spelling)
        assert r.status_code == 409 and r.json()["error"]["code"] == "UNIT_OCCUPIED", (spelling, r.text)
    accept_all(t1)
    assert add(t2.phone, "s 01").status_code == 409                       # occupied
    dup = owner.post("/api/v1/owner/units", json={"property_id": pid, "identifier": "s01", "kind": "commercial"})
    assert dup.status_code == 409, dup.text                               # no second copy of the same unit
    # a renter's number cannot also be an owner number of the same account
    assert owner.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": t1.phone, "relationship": "family"}]}).status_code == 409
    # after the tenant vacates, the same address can be let again
    tid1 = first.json()["tenancy_id"]
    ended = owner.post(f"/api/v1/owner/tenancies/{tid1}/end", params={"end_date": TODAY.isoformat()},
                       json={"deposit_note": "Held back for wall repair, bill to follow", "handover_note": "Keys returned"})
    assert ended.status_code == 200, ended.text
    notes = [n["body"] for n in t1.get(f"/api/v1/tenancies/{tid1}/notes").json()["items"]]
    assert any(n.startswith("Deposit: Held back") for n in notes) and any(n.startswith("Vacated: Keys") for n in notes), notes   # the renter sees the reason
    again = add(t2.phone, "S 01")
    assert again.status_code == 200, again.text


# a new rental needs the advance received (more than zero) and both its dates
def test_new_rental_requires_advance_and_both_dates(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    pid = ensure_property(owner)
    base = {"property_id": pid, "unit_identifier": "R-01", "tenant_name": "Ravi Kumar", "tenant_mobile": actor().phone,
            "monthly_rent": "10000", "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"}
    for change in ({"security_deposit": "0"}, {"end_date": None}):
        r = owner.post("/api/v1/owner/tenancies", json={**base, **change})
        assert r.status_code == 422, (change, r.text)
    assert owner.post("/api/v1/owner/tenancies", json=base).status_code == 200


# adding a renter texts the number straight away (even with no account yet); the owner can send it again, but not in a burst
def test_new_renter_is_texted_automatically_and_invite_can_be_resent(actor, monkeypatch):
    from app.modules import notify
    sent = []
    monkeypatch.setattr(notify, "invite_sms", lambda phone, owner, unit: sent.append((phone, unit)) or True)
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    newcomer = new_phone()                                                          # no RentMeezy account behind this number
    out = onboard(owner, newcomer)
    assert out["tenant_registered"] is False and out["invite_sms_sent"] is True
    assert [p for p, _ in sent] == ["+91" + newcomer[-10:]]                                      # texted on save, nothing for the owner to forward
    tid = out["tenancy_id"]
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/resend-invite").json()["status"] == "sent"
    assert len(sent) == 2
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/resend-invite").status_code == 429     # not twice in a row
    registered = actor()                                                            # already has the app: push + SMS through the normal queue
    out2 = onboard(owner, registered.phone)
    assert out2["tenant_registered"] is True and out2["invite_sms_sent"] is None and len(sent) == 2


# an email always belongs to one of the person's OWN mobile numbers (one email per number)
def test_email_belongs_to_one_of_my_numbers(actor):
    me, other = actor(), actor()
    prim = next(c for c in me.get("/api/v1/me").json()["contacts"] if c["kind"] == "mobile" and c["is_primary"])
    stranger_mobile = next(c for c in other.get("/api/v1/me").json()["contacts"] if c["kind"] == "mobile")
    mail = lambda n, **kw: me.post("/api/v1/me/contacts", json={"kind": "email", "value": f"{n}@example.com", **kw})
    assert mail("a").status_code == 422                                              # it must say which number it is for
    assert mail("a", for_mobile_id=stranger_mobile["id"]).status_code == 422         # not someone else's number
    ok = mail("a", for_mobile_id=prim["id"])
    assert ok.status_code == 200, ok.text
    assert mail("b", for_mobile_id=prim["id"]).status_code == 409                    # one email per number
    email = next(c for c in me.get("/api/v1/me").json()["contacts"] if c["kind"] == "email")
    assert email["for_mobile_id"] == prim["id"]
    second = me.post("/api/v1/me/contacts", json={"kind": "mobile", "value": new_phone()}).json()["contact_id"]
    assert mail("b", for_mobile_id=second).status_code == 200                        # the second number can have its own
    assert me.delete(f"/api/v1/me/contacts/{second}").status_code == 200             # removing that number takes its email with it
    emails = [c["value"] for c in me.get("/api/v1/me").json()["contacts"] if c["kind"] == "email"]
    assert emails == ["a@example.com"]


# a renter can write to the owner; it reaches the owner's bell (and nobody else's)
def test_renter_can_message_the_owner(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant, stranger = actor(), actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    url = f"/api/v1/tenant/tenancies/{tid}/messages"
    assert tenant.post(url, json={"text": "Hello"}).status_code == 404                  # not accepted yet: nothing to write to
    accept_all(tenant)
    assert stranger.post(url, json={"text": "Hi"}).status_code == 404                   # someone else's rental
    assert tenant.post(url, json={"text": "   "}).status_code == 422
    assert tenant.post(url, json={"text": "x" * 800}).status_code == 422
    sent = tenant.post(url, json={"text": "The tap in the kitchen is leaking", "lang": "en", "input_method": "voice"})
    assert sent.status_code == 200 and sent.json()["status"] == "sent", sent.text
    assert tenant.post(url, json={"text": "The tap in the kitchen is leaking"}).json()["status"] == "already_sent"   # a double tap
    bell = [n["text"] for n in owner.get("/api/v1/me/notifications?role=owner").json()["items"] if n["template"] == "renter_message"]
    assert len(bell) == 1 and "The tap in the kitchen is leaking" in bell[0]
    assert not [n for n in tenant.get("/api/v1/me/notifications?role=tenant").json()["items"] if n["template"] == "renter_message"]
    assert [m["text"] for m in tenant.get(url).json()["items"]] == ["The tap in the kitchen is leaking"]


# a renter added with the wrong number can be removed at once, but only until they accept
def test_wrong_number_can_be_removed_until_accepted(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    wrong, right = actor(), actor()
    pid = ensure_property(owner)

    def add(phone):
        return owner.post("/api/v1/owner/tenancies", json={"property_id": pid, "unit_identifier": "W-01", "tenant_name": "Ravi Kumar", "tenant_mobile": phone,
                                                           "monthly_rent": "10000", "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END})
    first = add(wrong.phone)
    assert first.status_code == 200, first.text
    assert add(right.phone).status_code == 409                                    # still offered to the wrong number
    tid = first.json()["tenancy_id"]
    gone = owner.post(f"/api/v1/owner/tenancies/{tid}/cancel-invite")
    assert gone.status_code == 200 and gone.json()["status"] == "cancelled", gone.text
    assert wrong.get("/api/v1/tenant/invitations").json()["items"] == []          # the wrong person no longer sees it
    second = add(right.phone)
    assert second.status_code == 200, second.text                                 # the address is free again
    accept_all(right)
    late = owner.post(f"/api/v1/owner/tenancies/{second.json()['tenancy_id']}/cancel-invite")
    assert late.status_code == 409, late.text                                     # accepted: must be vacated the normal way


# deposit amounts: a refund or adjustment can never be more than is held (or due); advance received never past the advance agreed
def test_deposit_amounts_are_limited(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone, deposit="5000")["tenancy_id"]          # agreed 5,000, recorded as received at onboarding
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})

    def dep(kind, amount, key):
        return owner.post(f"/api/v1/owner/tenancies/{tid}/deposit", json={"type": kind, "amount": amount, "reason": "test", "idempotency_key": key})
    r = dep("refund", "1000000", "dep-refund-big")                              # the case from the screen: 5,000 held, 10,00,000 typed
    assert r.status_code == 422 and "deposit held" in r.text and "₹5,000" in r.text, r.text
    assert dep("applied_to_dues", "6000", "dep-adj-big").status_code == 422
    assert dep("received", "1", "dep-more").status_code == 422                  # agreed 5,000 is already in full
    assert dep("refund", "2000", "dep-refund-ok").status_code == 200            # within what is held
    assert dep("refund", "2000", "dep-refund-ok").status_code == 200            # a retry returns the same record
    assert dep("refund", "3001", "dep-refund-over").status_code == 422          # only 3,000 is left


# rent relief: pay part of the month now, the rest moves to next month, and both sides read the same bill
def test_rent_relief_moves_the_rest_to_next_month(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant, stranger = actor(), actor()
    tid = onboard(owner, tenant.phone, rent="10000")["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    url = f"/api/v1/tenancies/{tid}/rent-relief"
    assert stranger.post(url, json={"period_month": M0.isoformat(), "pay_amount": "6000"}).status_code == 404
    assert tenant.post(url, json={"period_month": M0.isoformat(), "pay_amount": "10000"}).status_code == 422       # can pay it all: no relief needed
    r = tenant.post(url, json={"period_month": M0.isoformat(), "pay_amount": "6000", "reason": "Salary delayed this month"})
    assert r.status_code == 200 and r.json()["status"] == "requested", r.text
    rid = r.json()["id"]
    assert tenant.post(url, json={"period_month": M0.isoformat(), "pay_amount": "5000"}).status_code == 409        # one open request per month
    assert [x["id"] for x in owner.get("/api/v1/owner/rent-relief").json()["items"]] == [rid]
    assert tenant.get("/api/v1/owner/rent-relief").status_code in (403, 404)                                      # a renter has no owner list
    assert owner.get("/api/v1/dashboard".replace("/dashboard", "/owner/dashboard")).json()["metrics"]["relief_pending"] == 1

    decide = f"/api/v1/owner/rent-relief/{rid}/decide"
    assert owner.post(decide, json={"action": "approve", "pay_amount": "10000"}).status_code == 422               # must be less than what is unpaid
    assert stranger.post(decide, json={"action": "approve", "pay_amount": "5000"}).status_code in (403, 404)
    ok = owner.post(decide, json={"action": "approve", "pay_amount": "6000", "note": "Agreed, pay the rest next month"})
    assert ok.status_code == 200 and ok.json()["status"] == "approved" and ok.json()["deferred_paise"] == 400000, ok.text
    assert owner.post(decide, json={"action": "approve", "pay_amount": "6000"}).status_code in (400, 409, 422)       # decided once

    # both sides read the same bill: full month visible, 6,000 to pay now, 4,000 owed but moved to next month
    for who in (owner, tenant):
        b = who.get(f"/api/v1/tenancies/{tid}/bill", params={"month": M0.isoformat()}).json()
        assert b["summary"]["total_due_paise"] == 1000000 and b["summary"]["payable_now_paise"] == 600000, b["summary"]
        assert b["summary"]["this_month_open_paise"] == 600000
        assert any(l["kind"] == "credit_note" and l["amount_paise"] == -400000 for l in b["lines"])
        assert b["relief"]["status"] == "approved" and b["relief"]["agreed_pay_paise"] == 600000
    nxt = (M0.replace(day=28) + timedelta(days=5)).replace(day=1)
    nb = tenant.get(f"/api/v1/tenancies/{tid}/bill", params={"month": nxt.isoformat()}).json()
    carried = [l for l in nb["lines"] if l["amount_paise"] == 400000]
    assert carried and carried[0]["description"].startswith("Carried over from"), nb["lines"]
    assert nb["summary"]["this_month_open_paise"] == 400000

    # the renter can pay only what is payable now; the carried amount stays for next month
    assert tenant.get("/api/v1/tenant/rentals").json()["items"][0]["payable_now_paise"] == 600000
    over = owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "6001", "idempotency_key": "relief-cash-big"})
    assert over.status_code == 422, over.text
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "6000", "idempotency_key": "relief-cash-ok"}).status_code == 200
    after = tenant.get(f"/api/v1/tenancies/{tid}/bill", params={"month": M0.isoformat()}).json()["summary"]
    assert after["total_due_paise"] == 400000 and after["payable_now_paise"] == 0 and after["this_month_open_paise"] == 0
    assert any(i["template"] == "relief_approved" for i in tenant.get("/api/v1/tenant/updates").json()["items"])
    assert owner.post(url, json={"period_month": M0.isoformat(), "pay_amount": "1"}).status_code in (400, 403, 404, 422)   # an owner is not the renter


def test_rent_relief_decline_cancel_and_owner_grant(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone, rent="8000")["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    url = f"/api/v1/tenancies/{tid}/rent-relief"
    rid = tenant.post(url, json={"period_month": M0.isoformat(), "pay_amount": "2000"}).json()["id"]
    assert tenant.post(f"/api/v1/rent-relief/{rid}/cancel").json()["status"] == "cancelled"                       # the renter changes their mind
    assert "relief_requested" not in [i["template"] for i in owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()["items"]]
    rid = tenant.post(url, json={"period_month": M0.isoformat(), "pay_amount": "2000"}).json()["id"]
    assert owner.post(f"/api/v1/owner/rent-relief/{rid}/decide", json={"action": "decline", "note": "Please pay in full"}).json()["status"] == "declined"
    b = tenant.get(f"/api/v1/tenancies/{tid}/bill", params={"month": M0.isoformat()}).json()
    assert b["summary"]["total_due_paise"] == 800000 and b["summary"]["payable_now_paise"] == 800000       # nothing moved
    assert any(i["template"] == "relief_declined" for i in tenant.get("/api/v1/tenant/updates").json()["items"])
    g = owner.post(f"/api/v1/owner/tenancies/{tid}/rent-relief", json={"period_month": M0.isoformat(), "pay_amount": "5000", "note": "Festival month"})
    assert g.status_code == 200 and g.json()["initiated_by"] == "owner" and g.json()["deferred_paise"] == 300000, g.text    # no request needed
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/rent-relief", json={"period_month": M0.isoformat(), "pay_amount": "1000"}).status_code == 409   # once a month
    assert tenant.get(f"/api/v1/tenancies/{tid}/bill", params={"month": M0.isoformat()}).json()["summary"]["payable_now_paise"] == 500000


# the bell: every notification for this person with an unread count, and "seen" clears it
def test_notification_bell(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant, other = actor(), actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    assert other.get("/api/v1/me/notifications").json() == {"items": [], "unread": 0, "role": "tenant"}
    version = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
    assert owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": version, "monthly_rent": "12000"}).status_code == 200
    first = tenant.get("/api/v1/me/notifications").json()
    assert first["unread"] >= 1 and first["items"][0]["template"] == "terms_changed" and first["items"][0]["unread"] is True, first
    assert "₹12,000" in first["items"][0]["text"]
    assert tenant.post("/api/v1/me/notifications/seen").json() == {"unread": 0}
    after = tenant.get("/api/v1/me/notifications").json()
    assert after["unread"] == 0 and len(after["items"]) == len(first["items"]) and not any(i["unread"] for i in after["items"])
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "500", "idempotency_key": "bell-cash"}).status_code == 200
    again = tenant.get("/api/v1/me/notifications").json()
    assert again["unread"] == 1 and again["items"][0]["template"] == "cash_recorded"                      # only what is new since the last look
    assert other.get("/api/v1/me/notifications").json()["items"] == []                                 # nobody else's messages


# the bell follows the role in use; the home lists show where a relief request stands
def test_bell_is_per_role_and_lists_show_relief_status(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone, rent="10000")["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    assert tenant.post(f"/api/v1/tenancies/{tid}/rent-relief", json={"period_month": M0.isoformat(), "pay_amount": "4000", "reason": "Short this month"}).status_code == 200
    as_owner = owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()
    assert [i["template"] for i in as_owner["items"]][:1] == ["relief_requested"] and as_owner["unread"] == 1
    assert "relief_requested" not in [i["template"] for i in owner.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"]]   # not renter news
    assert owner.post("/api/v1/me/notifications/seen", params={"role": "owner"}).json() == {"unread": 0}
    assert owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()["unread"] == 0
    # where it stands, on the owner's renter row and the renter's rental card
    row = [x for x in owner.get("/api/v1/owner/tenancies").json()["items"] if x["id"] == tid][0]
    assert row["relief"]["status"] == "requested" and row["relief"]["requested_pay_paise"] == 400000
    card = [x for x in tenant.get("/api/v1/tenant/rentals").json()["items"] if x["id"] == tid][0]
    assert card["relief"]["status"] == "requested"
    rid = owner.get("/api/v1/owner/rent-relief").json()["items"][0]["id"]
    owner.post(f"/api/v1/owner/rent-relief/{rid}/decide", json={"action": "approve", "pay_amount": "4000"})
    gone = owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()
    assert "relief_requested" not in [i["template"] for i in gone["items"]] and gone["unread"] == 0          # answered: it leaves the bell
    assert owner.get("/api/v1/owner/dashboard").json()["metrics"]["relief_pending"] == 0
    assert [x for x in tenant.get("/api/v1/tenant/rentals").json()["items"] if x["id"] == tid][0]["relief"]["status"] == "approved"
    assert "relief_approved" in [i["template"] for i in tenant.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"]]


# commercial units on the dashboard, and the list of items provided with a rental
def test_commercial_units_and_items_provided(actor):
    import io
    from openpyxl import load_workbook
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    pid = ensure_property(owner)
    people = [actor(), actor(), actor()]

    def add(phone, ident, kind, items=None):
        body = {"property_id": pid, "unit_identifier": ident, "unit_kind": kind, "tenant_name": "Ravi Kumar", "tenant_mobile": phone, "monthly_rent": "10000",
                "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END}
        if items is not None:
            body["items_provided"] = items
        return owner.post("/api/v1/owner/tenancies", json=body)
    shop = add(people[0].phone, "S-1", "shop")                      # the old name "shop" still works: it is a commercial place
    house = add(people[1].phone, "H-1", "residential", "2 fans, 1 geyser\n  Gas stove  \n\n\n\nWater tank")
    fact = add(people[2].phone, "FACTORY", "commercial", "3-phase power, 2 loading docks, Crane; Office room")
    assert shop.status_code == house.status_code == fact.status_code == 200, (shop.text, house.text, fact.text)
    m = owner.get("/api/v1/owner/dashboard").json()["metrics"]
    assert (m["residential"], m["commercial"], m["units"]) == (1, 2, 3), m                 # only two kinds: a shop counts as commercial
    assert "shops" not in m and "houses" not in m
    assert int(m["pending_commercial_paise"]["value"]) >= 0 and "collected_residential_paise" in m and "overdue_commercial_paise" in m
    found = lambda q: {i["id"] for i in owner.get("/api/v1/owner/tenancies", params={"q": q}).json()["items"]}
    assert found("commercial") == found("shop") == found("factory") == {shop.json()["tenancy_id"], fact.json()["tenancy_id"]}     # a shop is a commercial place
    assert found("residential") == found("house") == {house.json()["tenancy_id"]}
    assert add(people[0].phone, "X-9", "castle").status_code == 422                       # only the known kinds

    # a place can be a number or a description, for both kinds; the floor is 0 (ground) to 10
    def raw(phone, ident, kind, floor=None):
        body = {"property_id": pid, "unit_identifier": ident, "unit_kind": kind, "tenant_name": "Ravi Kumar", "tenant_mobile": phone, "monthly_rent": "9000",
                "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END}
        if floor is not None:
            body["unit_floor"] = floor
        return owner.post("/api/v1/owner/tenancies", json=body)
    spare = [actor() for _ in range(5)]
    hostel = raw(spare[0].phone, "10-50 Hostel, 2 shops, 5 houses", "commercial", floor=2)
    assert hostel.status_code == 200, hostel.text
    assert raw(spare[1].phone, "Y" * 81, "commercial").status_code == 422 and raw(spare[1].phone, "Y" * 81, "residential").status_code == 422
    assert raw(spare[1].phone, "Bad <name>", "residential").status_code == 422                                   # odd characters are still refused
    assert raw(spare[1].phone, "Floor test", "commercial", floor=11).status_code == 422 and raw(spare[1].phone, "Floor test", "commercial", floor=-1).status_code == 422
    flat = raw(spare[3].phone, "Flat 4B, Block A", "residential", floor=4)                                       # a residential door number can be written freely too
    assert flat.status_code == 200, flat.text
    ground = raw(spare[2].phone, "G-1", "commercial", floor=0)
    assert ground.status_code == 200
    floors = {u["identifier"]: u["floor"] for u in owner.get("/api/v1/owner/units").json()["items"]}
    assert floors["10-50 Hostel, 2 shops, 5 houses"] == 2 and floors["G-1"] == 0 and floors["S-1"] is None
    row = [x for x in owner.get("/api/v1/owner/tenancies").json()["items"] if x["id"] == hostel.json()["tenancy_id"]][0]
    assert row["unit_floor"] == 2 and row["identifier"].startswith("10-50 Hostel")

    # items: kept as typed (tidied), seen by the renter, changed later with a message to the renter
    tid = house.json()["tenancy_id"]
    assert owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["items_provided"] == "2 fans, 1 geyser\nGas stove\n\nWater tank"
    accept_all(people[1])
    card = [x for x in people[1].get("/api/v1/tenant/rentals").json()["items"] if x["id"] == tid][0]
    assert card["items_provided"].startswith("2 fans")
    version = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
    r = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": version, "items_provided": "2 fans, 1 geyser, Gas stove, Water tank, Inverter"})
    assert r.status_code == 200 and "Inverter" in r.json()["tenancy"]["items_provided"], r.text
    assert any("items provided" in i["text"] for i in people[1].get("/api/v1/me/notifications").json()["items"])
    cleared = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": r.json()["tenancy"]["version"], "items_provided": "   "})
    assert cleared.status_code == 200 and cleared.json()["tenancy"]["items_provided"] is None
    too_long = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": cleared.json()["tenancy"]["version"], "items_provided": "x" * 2001})
    assert too_long.status_code == 422
    # the statement lists them too
    fid = fact.json()["tenancy_id"]
    wb = load_workbook(io.BytesIO(owner.get(f"/api/v1/tenancies/{fid}/statement", params={"format": "xlsx"}).content))
    assert wb.sheetnames[0] == "Items provided" and [r[0].value for r in wb["Items provided"].iter_rows(min_row=5)][:4] == ["3-phase power", "2 loading docks", "Crane", "Office room"]


# agreements: the bell reminds both sides 30 days before the end, until the owner renews; history is kept
def test_agreement_renewal_alerts_and_history(actor, sql):
    from datetime import timedelta
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    ext_tenant, lapsed_tenant = actor(), actor()
    pid = ensure_property(owner)
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()          # the server counts days in India time; late in the UTC evening it is already tomorrow there

    def add(phone, ident, start, end, inc=None):
        body = {"property_id": pid, "unit_identifier": ident, "tenant_name": "Ravi Kumar", "tenant_mobile": phone, "monthly_rent": "10000", "due_day": 5,
                "start_date": start.isoformat(), "end_date": end.isoformat(), "security_deposit": "1000"}
        if inc is not None:
            body["increment_percent"] = inc
        r = owner.post("/api/v1/owner/tenancies", json=body)
        assert r.status_code == 200, r.text
        return r.json()["tenancy_id"]
    far = add(actor().phone, "FAR-1", M0, today + timedelta(days=200))                                    # not yet near its end
    soon = add(ext_tenant.phone, "SOON-1", M0, today + timedelta(days=20), inc=10)
    gone = add(lapsed_tenant.phone, "GONE-1", M0.replace(year=M0.year - 1), today - timedelta(days=1), inc=5)
    accept_all(ext_tenant)
    accept_all(lapsed_tenant)

    for who, role in ((owner, "owner"), (ext_tenant, "tenant")):
        b = who.get("/api/v1/me/notifications", params={"role": role}).json()
        pinned = [i for i in b["items"] if i.get("pinned")]
        assert any(i["tenancy_id"] == soon and i["days_left"] == 20 and "20 days" in i["text"] for i in pinned), pinned
        assert not any(i["tenancy_id"] == far for i in pinned)                                           # more than 30 days away: no alert
        assert b["items"][0].get("pinned") and b["unread"] >= 1
        who.post("/api/v1/me/notifications/seen", params={"role": role})
        again = who.get("/api/v1/me/notifications", params={"role": role}).json()
        assert any(i.get("tenancy_id") == soon for i in again["items"]) and again["unread"] == 0          # still listed after looking
    assert any(i.get("tenancy_id") == gone and i["template"] == "agreement_lapsed_owner" and i["days_left"] == -1 for i in owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()["items"])
    assert not any(i.get("pinned") for i in owner.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"])   # owner news stays out of the renter bell

    # the agreement page: the increase is worked out, not typed
    a = ext_tenant.get(f"/api/v1/tenancies/{soon}/agreement").json()
    assert a["state"] == "ending_soon" and a["will_be"] == "extension" and a["can_renew"] is False
    assert (a["current_rent_paise"], a["increment_paise"], a["new_rent_paise"], a["increment_percent"]) == (1000000, 100000, 1100000, "10.00")
    assert [h["kind"] for h in a["history"]] == ["original"]
    assert ext_tenant.post(f"/api/v1/owner/tenancies/{soon}/agreement/renew", json={"new_end_date": (today + timedelta(days=400)).isoformat()}).status_code in (403, 404)
    assert owner.post(f"/api/v1/owner/tenancies/{soon}/agreement/renew", json={"new_end_date": (today + timedelta(days=10)).isoformat()}).status_code == 422   # must be later
    assert owner.get(f"/api/v1/tenancies/{soon}/agreement").json()["can_renew"] is True

    # renewed while it runs: an EXTENSION; the original row stays as it was
    new_end = today + timedelta(days=400)
    r = owner.post(f"/api/v1/owner/tenancies/{soon}/agreement/renew", json={"new_end_date": new_end.isoformat(), "note": "Another year"})
    assert r.status_code == 200 and r.json()["renewed_as"] == "extension", r.text
    hist = r.json()["history"]
    assert [h["kind"] for h in hist] == ["extension", "original"] and hist[1]["end_date"] == (today + timedelta(days=20)).isoformat() and hist[0]["end_date"] == new_end.isoformat()
    assert hist[0]["monthly_rent_paise"] == 1100000 and hist[1]["monthly_rent_paise"] == 1000000
    assert sql("SELECT monthly_rent_paise FROM rent_revisions WHERE tenancy_id = %s ORDER BY effective_month DESC LIMIT 1", soon)[0][0] == 1100000
    for who, role in ((owner, "owner"), (ext_tenant, "tenant")):
        assert not any(i.get("pinned") and i.get("tenancy_id") == soon for i in who.get("/api/v1/me/notifications", params={"role": role}).json()["items"])   # fixed: the reminder is gone
    assert any(i["template"] == "agreement_renewed" and "Another" not in i["text"] and "₹11,000" in i["text"] for i in ext_tenant.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"])
    try:
        sql("UPDATE tenancy_agreements SET monthly_rent_paise = 1 WHERE tenancy_id = %s", soon)
        raise AssertionError("agreement history must not be editable")
    except AssertionError:
        raise
    except Exception:
        pass                                                                                              # the database refuses: history is kept

    # renewed after it lapsed: a NEW agreement, starting the day after the old one ended
    g = owner.get(f"/api/v1/tenancies/{gone}/agreement").json()
    assert g["state"] == "lapsed" and g["will_be"] == "new" and g["new_rent_paise"] == 1050000
    n = owner.post(f"/api/v1/owner/tenancies/{gone}/agreement/renew", json={"new_end_date": (today + timedelta(days=365)).isoformat()})
    assert n.status_code == 200 and n.json()["renewed_as"] == "new", n.text
    assert n.json()["history"][0]["start_date"] == today.isoformat() and [h["kind"] for h in n.json()["history"]] == ["new", "original"]


# a place is building + floor + number: many residents in one building, but never the same number on the same floor
def test_same_number_on_different_floors(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    pid = ensure_property(owner)
    people = [actor() for _ in range(7)]

    def add(i, ident, floor=None):
        body = {"property_id": pid, "unit_identifier": ident, "tenant_name": "Ravi Kumar", "tenant_mobile": people[i].phone, "monthly_rent": "9000",
                "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END}
        if floor is not None:
            body["unit_floor"] = floor
        return owner.post("/api/v1/owner/tenancies", json=body)
    first = add(0, "Room 1", 1)
    assert first.status_code == 200, first.text
    assert add(1, "Room 1", 2).status_code == 200                                         # same number, another floor: a different place
    taken = add(2, "room-1", 1)                                                           # same number, same floor, other spelling
    assert taken.status_code == 409 and taken.json()["error"]["code"] == "UNIT_OCCUPIED" and "1st floor" in taken.json()["error"]["message"], taken.text
    ambiguous = add(2, "Room 1")                                                          # no floor given, but the number is on two floors
    assert ambiguous.status_code == 422 and ambiguous.json()["error"]["fields"][0]["code"] == "floor_required", ambiguous.text
    assert add(2, "Room 2").status_code == 200                                            # no floor at all is a place of its own
    assert add(3, "ROOM 2").status_code == 409                                            # ... and cannot be taken twice
    assert add(4, "R-3", 3).status_code == 200
    assert add(5, "R-3").status_code == 409                                               # no floor given, one place has this number: that place, which is taken
    dup = owner.post("/api/v1/owner/units", json={"property_id": pid, "identifier": "Room 1", "kind": "residential", "floor": 1})
    assert dup.status_code == 409 and "1st floor" in dup.text, dup.text
    assert owner.post("/api/v1/owner/units", json={"property_id": pid, "identifier": "Room 1", "kind": "residential", "floor": 3}).status_code == 200
    places = sorted((u["identifier"], u["floor"]) for u in owner.get("/api/v1/owner/units").json()["items"] if u["identifier"].lower().startswith("room 1"))
    assert places == [("Room 1", 1), ("Room 1", 2), ("Room 1", 3)]
    # when the first resident leaves, that floor's Room 1 can be let again
    assert owner.post(f"/api/v1/owner/tenancies/{first.json()['tenancy_id']}/end", params={"end_date": TODAY.isoformat()}).status_code == 200
    assert add(6, "Room 1", 1).status_code == 200


# a rent change cannot be dated before the rental began
def test_rent_change_cannot_start_before_the_rental(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone, rent="10000")["tenancy_id"]
    accept_all(tenant)
    version = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
    early = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": version, "monthly_rent": "11000", "rent_effective_month": (M0.replace(day=1) - timedelta(days=40)).isoformat()})
    assert early.status_code == 422 and early.json()["error"]["fields"][0]["code"] == "before_start", early.text
    ok = owner.patch(f"/api/v1/owner/tenancies/{tid}", json={"version": version, "monthly_rent": "11000", "rent_effective_month": M0.isoformat()})
    assert ok.status_code == 200, ok.text


# owner -> renter message: spoken or typed in one language, translated into the renter's, to the bell and (when chosen) SMS / WhatsApp
def test_message_to_renter_with_translation(actor, sql, monkeypatch):
    import types
    from app.modules import messages as msg
    owner = actor(roles=("owner",))
    pay_subscription(owner)                                                   # growth plan: AI included
    tenant, stranger = actor(), actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    info = owner.get(f"/api/v1/owner/tenancies/{tid}/message-info").json()
    assert info["can_message"] is False                                       # the renter has not accepted yet
    assert owner.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": "Hello", "original_text": "Hello", "from_lang": "en", "to_lang": "en", "request_id": "msg-early-1"}).status_code == 409
    accept_all(tenant)
    sql("UPDATE users SET preferred_language = 'ta' WHERE id = %s", tenant.id)
    info = owner.get(f"/api/v1/owner/tenancies/{tid}/message-info").json()
    assert info["can_message"] is True and info["renter_language"] == "ta" and info["unit"]    # 'Send in' starts on the renter's own language
    ch = owner.get("/api/v1/owner/messages/channels").json()
    assert ch["bell"]["available"] and ch["sms"]["mode"] == "test" and ch["whatsapp"]["mode"] == "test"

    # translation: same language needs no AI; different languages go through the plan's AI allowance and come with a check-back line
    same = owner.post("/api/v1/owner/messages/translate", json={"text": "Rent is due on 5th", "from_lang": "en", "to_lang": "en", "request_id": "tr-same-0001"}).json()
    assert same["same_language"] is True and same["translation"] == "Rent is due on 5th" and same["usage"]["tokens"] == 0
    tr = owner.post("/api/v1/owner/messages/translate", json={"text": "Rent of 12,000 is due on 5th", "from_lang": "en", "to_lang": "ta", "request_id": "tr-ta-000001"})
    assert tr.status_code == 200, tr.text
    t1 = tr.json()
    assert t1["translation"].startswith("[ta] ") and t1["back_translation"].startswith("[en] ") and "12,000" in t1["back_translation"] and t1["numbers_ok"] is True
    assert msg._numbers_kept("Rent 12,000 due 5th", "வாடகை 12000 5") and not msg._numbers_kept("Rent 12,000 due 5th", "வாடகை 1200 5")   # a changed number is caught
    assert owner.post("/api/v1/owner/messages/translate", json={"text": "x" * 800, "from_lang": "en", "to_lang": "ta", "request_id": "tr-long-0001"}).status_code == 422
    assert stranger.post("/api/v1/owner/messages/translate", json={"text": "Hi", "from_lang": "en", "to_lang": "ta", "request_id": "tr-stranger1"}).status_code in (402, 403, 404, 409)

    # send: the bell always; SMS / WhatsApp only when chosen
    sent = owner.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": t1["translation"], "original_text": "Rent of 12,000 is due on 5th", "from_lang": "en", "to_lang": "ta",
                                                                       "input_method": "voice", "channels": ["sms", "whatsapp"], "request_id": "msg-send-0001"})
    assert sent.status_code == 200 and sent.json()["channels"] == ["bell", "sms", "whatsapp"], sent.text
    dup = owner.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": t1["translation"], "original_text": "Rent of 12,000 is due on 5th", "from_lang": "en", "to_lang": "ta",
                                                                      "channels": ["sms", "whatsapp"], "request_id": "msg-send-0002"})
    assert dup.json()["status"] == "already_sent"                              # a double tap does not send twice
    got = tenant.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"]
    assert any(i["template"] == "owner_message" and i["text"].endswith(t1["translation"]) and i["tenancy_id"] == tid for i in got), got
    mine = owner.get("/api/v1/me/notifications", params={"role": "owner"}).json()["items"]
    assert any(i["template"] == "message_sent" and "bell, sms, whatsapp" in i["text"] for i in mine), mine
    assert not any(i["template"] == "owner_message" for i in owner.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"])
    channels = sorted(r[0] for r in sql("SELECT channel FROM notification_events WHERE dedupe_key LIKE 'owner-msg:%%' AND user_id = %s", tenant.id))
    assert channels == ["push", "sms", "whatsapp"]
    hist = owner.get(f"/api/v1/owner/tenancies/{tid}/messages").json()["items"]
    assert len(hist) == 1 and hist[0]["original_text"].startswith("Rent of") and hist[0]["sent_lang"] == "ta" and hist[0]["channels"] == ["bell", "sms", "whatsapp"]

    # limits: only the owner of that rental; a channel that is not connected is refused
    assert stranger.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": "Hi there", "original_text": "Hi there", "from_lang": "en", "to_lang": "en", "request_id": "msg-strang-01"}).status_code in (403, 404)
    assert tenant.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": "Hi there", "original_text": "Hi there", "from_lang": "en", "to_lang": "en", "request_id": "msg-renter-01"}).status_code in (403, 404)
    monkeypatch.setattr(msg, "get_settings", lambda: types.SimpleNamespace(sms_provider="someprovider", whatsapp_provider="console"))
    refused = owner.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": "Second note", "original_text": "Second note", "from_lang": "en", "to_lang": "en", "channels": ["sms"], "request_id": "msg-nosms-001"})
    assert refused.status_code == 400 and refused.json()["error"]["code"] == "CHANNEL_NOT_CONNECTED", refused.text


def test_a_message_can_be_sent_without_the_ai_plan(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner, "starter")                                         # no AI on this plan
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    assert owner.post("/api/v1/owner/messages/translate", json={"text": "Hi", "from_lang": "en", "to_lang": "ta", "request_id": "tr-noai-0001"}).status_code in (402, 403)
    ok = owner.post(f"/api/v1/owner/tenancies/{tid}/messages", json={"text": "Please call me", "original_text": "Please call me", "from_lang": "en", "to_lang": "en", "request_id": "msg-noai-0001"})
    assert ok.status_code == 200, ok.text                                      # typing in the renter's own language needs no AI
    assert any(i["template"] == "owner_message" for i in tenant.get("/api/v1/me/notifications", params={"role": "tenant"}).json()["items"])


# every plan on sale carries its AI settings and its message allowance (a plan version without them would silently mean "none")
def test_every_active_plan_is_complete(sql):
    rows = sql("""SELECT p.code, p.version, p.max_units, e.plan_id IS NOT NULL, l.paid_units FROM subscription_plans p
                  LEFT JOIN plan_ai_entitlements e ON e.plan_id = p.id LEFT JOIN plan_message_limits l ON l.plan_id = p.id
                  WHERE p.status = 'active' ORDER BY p.sort_order""")
    assert [(r[0], r[2]) for r in rows] == [("starter", 10), ("growth", 100), ("business", 250), ("max", 1000)]
    assert all(r[3] for r in rows), rows
    assert [r[4] for r in rows] == [20, 150, 400, 1000], rows


# a plan covers ONE property; the Max plan covers many (up to its limit) under one subscription
def test_properties_per_plan(actor, sql):
    from app.modules import properties as _p  # noqa: F401  (keeps the module loaded for the property helpers)
    growth, big = actor(roles=("owner",)), actor(roles=("owner",))
    pay_subscription(growth, "starter")                                        # Starter covers one property
    pid = ensure_property(growth)                                              # the one property of this plan
    again = growth.post("/api/v1/owner/properties", json=property_body())
    assert again.status_code in (400, 409), again.text                         # a second property needs its own subscription
    assert growth.get("/api/v1/me").json()["owner_accounts"][0]["property_capacity"] == 1
    pay_subscription(big, "max")
    me = big.get("/api/v1/me").json()["owner_accounts"][0]
    assert me["property_capacity"] == 100 and me["property_count"] == 0
    sql("UPDATE subscription_plans SET max_properties = 3 WHERE code = 'max'")           # a small limit, so the edge can be tested quickly
    try:
        for _ in range(3):
            r = big.post("/api/v1/owner/properties", json=property_body())
            assert r.status_code == 200, r.text
        fourth = big.post("/api/v1/owner/properties", json=property_body())
        assert fourth.status_code in (400, 409) and "PROPERTY_NEEDS_SUBSCRIPTION" in fourth.text, fourth.text
        me = big.get("/api/v1/me").json()["owner_accounts"][0]
        assert (me["property_count"], me["property_capacity"]) == (3, 3)
        assert big.get("/api/v1/subscription").json()["properties_capacity"] == 3
    finally:
        sql("UPDATE subscription_plans SET max_properties = 100 WHERE code = 'max'")


# the regular price can never be at or below the price charged, and the saving is exact
def test_regular_price_must_be_higher_than_the_launch_price(sql):
    from app.modules.subscriptions import _plan_view
    row = {"price_paise": 5000, "regular_price_paise": 6500, "code": "x"}
    assert (_plan_view(row)["saving_percent"], _plan_view(row)["saving_paise"]) == (23, 1500)
    assert _plan_view({"price_paise": 100, "regular_price_paise": None, "code": "s"})["saving_percent"] is None
    assert _plan_view({"price_paise": 5000, "regular_price_paise": 5000, "code": "x"})["saving_percent"] is None       # nothing to show if it is not higher
    assert _plan_view({"price_paise": 100, "regular_price_paise": 101, "code": "x"})["saving_percent"] == 1                # rounds to a whole percent
    try:
        sql("UPDATE subscription_plans SET regular_price_paise = price_paise WHERE code = 'growth' AND status = 'active'")
        raise AssertionError("a regular price equal to the launch price must be refused")
    except AssertionError:
        raise
    except Exception:
        pass


# a plan covers a number of properties: an account holding more than a smaller plan covers cannot move onto it
def test_cannot_move_to_a_plan_with_fewer_properties(actor, sql):
    owner = actor(roles=("owner",))
    pay_subscription(owner, "max")
    sql("UPDATE subscription_plans SET max_properties = 3 WHERE code = 'max'")
    try:
        for _ in range(3):
            assert owner.post("/api/v1/owner/properties", json=property_body()).status_code == 200
        down = owner.post("/api/v1/subscription/change-plan", json={"plan_code": "starter", "idempotency_key": uuid.uuid4().hex})
        assert down.status_code == 400 and down.json()["error"]["code"] == "PROPERTY_CAPACITY_EXCEEDED", down.text
        assert down.json()["error"]["fields"][0]["code"] == "too_many_properties"
        ok = owner.post("/api/v1/subscription/change-plan", json={"plan_code": "growth", "idempotency_key": uuid.uuid4().hex})
        assert ok.status_code == 200, ok.text                                      # Growth covers 5 properties, so 3 fit
    finally:
        sql("UPDATE subscription_plans SET max_properties = 100 WHERE code = 'max'")


# [11] notes
def test_note_limits(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    ok = tenant.post(f"/api/v1/tenancies/{tid}/notes", json={"target_type": "tenancy", "target_id": tid, "body": "க்ஷ" * 250, "input_method": "voice"})
    assert ok.status_code == 200
    bad = tenant.post(f"/api/v1/tenancies/{tid}/notes", json={"target_type": "tenancy", "target_id": tid, "body": "a" * 251})
    assert bad.status_code == 422
    priv = tenant.post(f"/api/v1/tenancies/{tid}/notes", json={"target_type": "tenancy", "target_id": tid, "body": "x", "visibility": "owner_private"})
    assert priv.status_code == 403


# [5] primary mobile change keeps the same internal user and data
def test_mobile_change_preserves_identity(actor, client):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    old_id = tenant.id
    new = new_phone()
    r = tenant.post("/api/v1/me/mobile-change/start", json={"new_phone": new})
    assert r.status_code == 200, r.text
    rid = r.json()["request_id"]
    code = client.post("/api/v1/dev/otp/request", json={"phone": new}).json()["demo_code"]
    tok = client.post("/api/v1/dev/otp/verify", json={"phone": new, "code": code}, headers=tenant.h()).json()["id_token"]
    tenant.token = tok
    assert tenant.post("/api/v1/me/mobile-change/complete", json={"request_id": rid}).json()["status"] == "completed"
    code = client.post("/api/v1/dev/otp/request", json={"phone": new}).json()["demo_code"]
    tenant.token = client.post("/api/v1/dev/otp/verify", json={"phone": new, "code": code}).json()["id_token"]
    me = tenant.get("/api/v1/me").json()
    assert me["id"] == old_id
    assert [c["value"] for c in me["contacts"] if c["is_primary"] and c["kind"] == "mobile"] == ["+91" + new]
    assert tenant.get("/api/v1/tenant/rentals").json()["items"][0]["id"] == tid


# [3] Excel import with valid/invalid rows
def test_excel_import_preview_and_commit(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner, "growth")
    ensure_property(owner)                                  # imports add renters to the account's registered, verified property
    wb = load_workbook(io.BytesIO(build_template()))
    ws = wb["Tenancies"]
    ws.append(["12 Market Road, Madurai", "", "", "", "", "S-99", "shop", "Bad Row", "123", 100, 5, "01-04-2026", 0])
    buf = io.BytesIO()
    wb.save(buf)
    r = owner.post("/api/v1/owner/imports", files={"file": ("t.xlsx", buf.getvalue(),
                   "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}).json()
    assert [row["valid"] for row in r["rows"]] == [True, True, False]
    c = owner.post(f"/api/v1/owner/imports/{r['job_id']}/commit").json()
    assert c["imported"] == 2 and c["failed"] == []
    assert owner.post(f"/api/v1/owner/imports/{r['job_id']}/commit").status_code == 409   # no double import


# [15] AI gating and metering
def test_ai_plan_gating_and_usage(actor):
    starter = actor(roles=("owner",))
    pay_subscription(starter, "starter")
    r = starter.post("/api/v1/owner/ai/ask", json={"question": "How much collected this month?", "request_id": uuid.uuid4().hex})
    assert r.status_code == 402
    growth = actor(roles=("owner",))
    pay_subscription(growth, "growth")
    rid = uuid.uuid4().hex
    r = growth.post("/api/v1/owner/ai/ask", json={"question": "How much collected this month?", "request_id": rid})
    assert r.status_code == 200, r.text
    assert "collected_this_month" in r.json()["facts"]
    assert growth.post("/api/v1/owner/ai/ask", json={"question": "again", "request_id": rid}).status_code == 409
    u = growth.get("/api/v1/owner/ai/usage").json()
    assert u["allowance"] == 100000 and 0 < u["used"] < 100000        # Growth: 1 lakh tokens a month


# [6] owner proposes a tenant contact change; cannot hijack the tenant's identity
def test_owner_contact_proposal_needs_tenant(actor, sql):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    before = tenant.get("/api/v1/me").json()
    # owner edits only their own record of the tenant
    assert owner.put(f"/api/v1/owner/tenancies/{tid}/contact", json={"name": "Ravi K (Shop 1)"}).status_code == 200
    assert tenant.get("/api/v1/me").json()["full_name"] == before["full_name"]
    alt = new_phone()
    p = owner.post(f"/api/v1/owner/tenancies/{tid}/contact-proposals", json={"field": "secondary_mobile", "new_value": alt}).json()
    assert tenant.get("/api/v1/me").json()["contacts"] == before["contacts"]        # nothing changed yet
    r = tenant.post(f"/api/v1/tenant/contact-proposals/{p['proposal_id']}/accept").json()
    assert r["next"] == "verify_contact"
    added = [c for c in tenant.get("/api/v1/me").json()["contacts"] if c["value"] == "+91" + alt]
    assert added and added[0]["verified"] is False                                   # tenant must verify by OTP
    prim = owner.post(f"/api/v1/owner/tenancies/{tid}/contact-proposals", json={"field": "primary_mobile", "new_value": new_phone()}).json()
    r = tenant.post(f"/api/v1/tenant/contact-proposals/{prim['proposal_id']}/accept").json()
    assert r["next"] == "start_change_primary_mobile"                                # never applied by the owner
    assert tenant.get("/api/v1/me").json()["id"] == before["id"]


# [13] closing one tenancy leaves the tenant's other owners untouched and keeps history
def test_close_one_tenancy_keeps_others(actor):
    a, b = actor(roles=("owner",)), actor(roles=("owner",))
    pay_subscription(a)
    pay_subscription(b)
    tenant = actor()
    ta = onboard(a, tenant.phone)["tenancy_id"]
    tb = onboard(b, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    a.post(f"/api/v1/owner/tenancies/{ta}/invoices", params={"month": M0.isoformat()})
    r = a.post(f"/api/v1/owner/tenancies/{ta}/end", params={"end_date": date(TODAY.year + 1, 1, 1).isoformat()})
    assert r.status_code == 200 and r.json()["status"] == "ended"
    rentals = {x["id"]: x["status"] for x in tenant.get("/api/v1/tenant/rentals").json()["items"]}
    assert rentals == {ta: "ended", tb: "active"}
    assert tenant.get(f"/api/v1/tenancies/{ta}/history").status_code == 200        # final statement still available
    assert tenant.get(f"/api/v1/tenancies/{ta}/statement").status_code == 200


# Owner details are required before an owner can add properties or tenants.
def test_owner_details_gate_and_unique_pan(client, actor):
    from .conftest import Actor
    o = Actor(client, roles=("owner",))
    # Actor submits details by default; use a fresh owner and strip them to test the gate
    fresh = Actor.__new__(Actor)
    fresh.c, fresh.phone = client, new_phone()
    r = client.post("/api/v1/dev/otp/request", json={"phone": fresh.phone})
    fresh.token = client.post("/api/v1/dev/otp/verify", json={"phone": fresh.phone, "code": r.json()["demo_code"]}).json()["id_token"]
    fresh.post("/api/v1/auth/session")
    fresh.post("/api/v1/me/roles", json={"roles": ["owner"]})
    me = fresh.get("/api/v1/me").json()
    fresh.put("/api/v1/me/profile", json={"full_name": "No Details", "preferred_language": "en", "version": me["version"]})
    assert fresh.get("/api/v1/owner/verification").json()["status"] == "none"
    r = fresh.post("/api/v1/owner/properties", json=property_body())
    assert r.status_code == 409 and r.json()["error"]["code"] == "OWNER_DETAILS_REQUIRED"
    body = {"legal_name": "No Details", "pan": "abcde1234f", "address": "5 Gate Road, Madurai", "proof_type": "gst", "proof_ref": "GST-0001", "declare": True}
    assert fresh.put("/api/v1/owner/verification", json={**body, "declare": False}).status_code == 422
    assert fresh.put("/api/v1/owner/verification", json={**body, "pan": "BAD"}).status_code == 422
    assert fresh.put("/api/v1/owner/verification", json=body).json()["status"] == "submitted"
    assert fresh.get("/api/v1/owner/verification").json()["pan_masked"] == "AB••••••4F"
    # the same PAN cannot back a second owner account
    other = Actor(client, roles=("owner",))
    assert other.put("/api/v1/owner/verification", json=body).status_code == 409


# Identity verification: consent first, outcome-only storage, never auto-verify on a partial pass, withdrawal.
def test_identity_verification_flow(client, actor):
    from app.providers.kyc import SandboxKyc
    u = actor(roles=("owner",), identity=False)
    assert u.get("/api/v1/me/identity").json()["status"] == "none"
    notice = u.get("/api/v1/me/identity").json()["notice_version"]
    assert u.post("/api/v1/me/identity/start", json={"consent": False, "notice_version": notice}).status_code == 422
    out = u.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice}).json()
    assert out["status"] == "pending" and out["session"]["mode"] == "sandbox"
    again = u.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice}).json()
    assert again["id"] == out["id"]                                              # idempotent while open
    sid = out["session"]["url"].rsplit("/", 1)[1]
    # a replayed/forged webhook without a valid signature is rejected
    assert client.post("/api/v1/webhooks/kyc", content=b"{}", headers={"x-kyc-signature": "bad"}).status_code == 403
    p = SandboxKyc("sandbox-kyc-webhook-secret", "http://testserver")
    body = p.build_event(sid, "verified")
    assert client.post("/api/v1/webhooks/kyc", content=body, headers={"x-kyc-signature": p.sign(body)}).status_code == 200
    me = u.get("/api/v1/me").json()
    assert me["identity_status"] == "verified"
    got = u.get("/api/v1/me/identity").json()
    assert got["face_matched"] and got["liveness_passed"] and got["name_matched"] and got["expires_at"]
    # replay does not change anything; a later failed event cannot downgrade a verified identity
    fail = p.build_event(sid, "failed")
    client.post("/api/v1/webhooks/kyc", content=fail, headers={"x-kyc-signature": p.sign(fail)})
    assert u.get("/api/v1/me/identity").json()["status"] == "verified"
    assert u.delete("/api/v1/me/identity").json()["status"] == "none"
    assert u.get("/api/v1/me").json()["identity_status"] == "none"


def test_identity_partial_pass_goes_to_manual_review_and_reviewer_api_is_hidden(client, actor, monkeypatch):
    from app.core import config
    from app.providers.kyc import SandboxKyc
    u = actor(roles=("owner",), identity=False)
    notice = u.get("/api/v1/me/identity").json()["notice_version"]
    sid = u.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice}).json()["session"]["url"].rsplit("/", 1)[1]
    p = SandboxKyc("sandbox-kyc-webhook-secret", "http://testserver")
    body = p.build_event(sid, "manual_review")
    client.post("/api/v1/webhooks/kyc", content=body, headers={"x-kyc-signature": p.sign(body)})
    assert u.get("/api/v1/me/identity").json()["status"] == "manual_review"
    # reviewer API does not exist unless an admin token is configured and supplied
    assert client.get("/api/v1/admin/review").status_code == 404
    monkeypatch.setattr(config.get_settings(), "admin_token", "rev-token-123")
    assert client.get("/api/v1/admin/review", headers={"x-admin-token": "wrong"}).status_code == 404
    q = client.get("/api/v1/admin/review", headers={"x-admin-token": "rev-token-123"}).json()
    assert any(i["id"] for i in q["identity"])
    iid = u.get("/api/v1/me/identity").json()["id"]
    r = client.post(f"/api/v1/admin/review/identity/{iid}", json={"decision": "approve"}, headers={"x-admin-token": "rev-token-123"})
    assert r.status_code == 200 and u.get("/api/v1/me/identity").json()["status"] == "verified"


def test_demo_approve_completes_manual_review(client, actor):
    from app.providers.kyc import SandboxKyc
    u = actor(roles=("owner",), identity=False)
    notice = u.get("/api/v1/me/identity").json()["notice_version"]
    assert u.post("/api/v1/me/identity/demo-approve").status_code == 404          # nothing waiting yet
    sid = u.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice}).json()["session"]["url"].rsplit("/", 1)[1]
    p = SandboxKyc("sandbox-kyc-webhook-secret", "http://testserver")
    body = p.build_event(sid, "manual_review")
    client.post("/api/v1/webhooks/kyc", content=body, headers={"x-kyc-signature": p.sign(body)})
    assert u.post("/api/v1/me/identity/demo-approve").json()["status"] == "verified"


def test_pan_encrypted_at_rest_and_unique(client, actor, sql):
    a = actor(roles=("owner",))
    rows = sql("""SELECT v.pan_enc, v.pan_hash, v.pan_masked, v.pan FROM owner_verifications v
                  JOIN owner_memberships m ON m.owner_account_id = v.owner_account_id WHERE m.user_id = %s""", a.id)
    enc, h, masked, plain = rows[0]
    assert plain is None and enc and h and "••" in masked and "ABCDE" not in enc
    from app.core import crypto
    assert crypto.decrypt(enc).startswith("ABCDE") and crypto.lookup_hash(crypto.decrypt(enc)) == h


def test_rate_limiter_is_shared_in_database(client):
    import uuid

    import pytest

    from app.core.errors import AppError
    from app.core.http import RateLimiter
    key = f"t:{uuid.uuid4().hex}"
    for _ in range(3):
        RateLimiter().check(key, 3, 60)          # a new instance each time: the counter lives in PostgreSQL
    with pytest.raises(AppError) as e:
        RateLimiter().check(key, 3, 60)
    assert e.value.code == "RATE_LIMITED"


def test_oversized_body_rejected(client):
    r = client.post("/api/v1/dev/otp/request", content=b"x" * (9 * 1024 * 1024), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_production_refuses_unsafe_config():
    import pytest

    from app.core.config import Settings
    with pytest.raises(ValueError):
        Settings(app_env="production", dev_auth_enabled=False, firebase_project_id="p")


def test_export_and_close_account(client, actor, sql):
    a = actor(roles=("owner",))
    data = a.get("/api/v1/me/export").json()
    c = a.get("/api/v1/me/export", params={"format": "csv"})
    assert c.status_code == 200 and c.headers["content-type"].startswith("text/csv") and c.headers["content-disposition"].endswith('.csv"')
    assert "Test User" in c.content.decode("utf-8-sig")
    f = a.get("/api/v1/me/export", params={"format": "pdf"})
    assert f.status_code == 200 and f.content[:4] == b"%PDF"
    assert a.get("/api/v1/me/export", params={"format": "xml"}).status_code == 422
    assert data["profile"]["full_name"] == "Test User" and data["owner_details"][0]["pan_masked"].startswith("AB")
    assert a.post("/api/v1/me/close-account", json={"confirm": "no"}).status_code == 422
    assert a.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 200
    assert a.get("/api/v1/me").status_code in (401, 403)          # signed out everywhere
    row = sql("SELECT full_name, address, status FROM users WHERE id = %s", a.id)[0]
    assert row[0] == "Closed account" and row[1] is None and row[2] == "closed"
    # the same number can register again as a brand-new account
    b = actor(phone=a.phone)
    assert b.id != a.id


def test_cannot_close_with_active_rental(client, actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    assert tenant.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 409
    assert owner.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 409


def test_plan_message_cap_holds_back_paid_channels(client, actor, sql):
    import uuid

    from app.core.db import transaction
    from app.modules import notify
    owner = actor(roles=("owner",))
    pay_subscription(owner, "starter")                     # starter allowance: 20 paid units a month
    oid = sql("SELECT owner_account_id FROM owner_memberships WHERE user_id = %s", owner.id)[0][0]
    params = {"unit": "U", "amount": "Rs 1", "due_date": "01-01-2030"}
    sql("UPDATE notification_preferences SET quiet_start = '00:00', quiet_end = '00:00', sms_enabled = true WHERE user_id = %s", owner.id)   # quiet hours off: test must not depend on the clock
    with transaction() as db:
        for i in range(25):
            notify.enqueue(db, owner.id, "rent_reminder", params, f"cap:{uuid.uuid4().hex}", owner=oid, channels=("sms",))
    with transaction() as db:
        notify.dispatch_pending(db, limit=5000)             # other tests leave messages queued; this one must reach its own
    with transaction() as db:
        u = notify.message_usage(db, oid)
    assert u["paid_units_limit"] == 20 and u["paid_units_used"] <= 20
    capped = sql("SELECT count(*) FROM notification_events WHERE owner_account_id = %s AND skip_reason = 'plan_message_cap'", oid)[0][0]
    assert capped >= 5


# a property is accepted only from an owner whose photo ID has been verified
def test_property_needs_a_verified_photo_id(actor):
    o = actor(roles=("owner",), identity=False)
    pay_subscription(o)
    for url in ("/api/v1/owner/properties/check", "/api/v1/owner/properties"):
        r = o.post(url, json=property_body())
        assert r.status_code == 409 and r.json()["error"]["code"] == "IDENTITY_REQUIRED", (url, r.text)
    o.verify_identity()
    assert o.post("/api/v1/owner/properties", json=property_body()).status_code == 200


# free search: status words, kind words and normal text, several words together, any order
def test_owner_search_understands_status_words(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    t_owing, t_clear = actor(), actor()
    a = onboard(owner, t_owing.phone)["tenancy_id"]
    b = onboard(owner, t_clear.phone)["tenancy_id"]
    accept_all(t_owing)
    accept_all(t_clear)
    for t in (a, b):
        owner.post(f"/api/v1/owner/tenancies/{t}/invoices", params={"month": M0.isoformat()})
    due = owner.get(f"/api/v1/tenancies/{b}/bill").json()["summary"]["total_due_paise"]
    owner.post(f"/api/v1/owner/tenancies/{b}/payments/cash", json={"amount": str(due // 100), "idempotency_key": "srch-" + b})

    def found(q):
        return {i["id"] for i in owner.get("/api/v1/owner/tenancies", params={"q": q}).json()["items"]}

    for word in ("pending", "unpaid", "Due", "  BALANCE  "):
        assert found(word) == {a}, word
    for word in ("paid", "paid up", "cleared"):
        assert found(word) == {b}, word
    assert found("unpaid paid") == set()                         # contradictory words match nothing
    assert found("overdue") <= {a}
    assert {a, b} <= found("shop") | found("house") | found("commercial") | found("residential")     # the kind words work
    assert found("pending zzzz-no-such-name") == set()           # every word has to match
    for part in ("unp", "UNP", "pen", "bal"):                    # 3 letters are enough
        assert found(part) == {a}, part
    assert found("pai") >= {b}                                   # "pai" is the start of paid
    assert a not in found("un")                                  # fewer than 3 letters are text only, never a status word
    assert found("%") == set() and found("_") == set()          # wildcards are plain characters
    last4 = found(t_owing.phone[-4:])                          # the last 4 digits of the phone (test numbers are sequential, so they can sit inside the other number too)
    assert a in last4 and (b in last4) == (t_owing.phone[-4:] in t_clear.phone)
    assert found("invited") == set() and a in found("active")  # renter status words
    rent = owner.get("/api/v1/owner/tenancies").json()["items"][0]["monthly_rent_paise"] // 100
    assert {a, b} <= found(str(rent))                          # the rent amount in rupees


# cash is recorded only after the owner confirms they personally received it
def test_cash_needs_the_owners_confirmation(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    url = f"/api/v1/owner/tenancies/{tid}/payments/cash"
    body = {"amount": "1000", "idempotency_key": "cash-conf-" + tid}
    for bad in ({**body, "cash_received_confirmed": False},):
        r = owner.post(url, json=bad)
        assert r.status_code == 422 and "confirm" in r.json()["error"]["message"]
    assert tenant.get(f"/api/v1/tenancies/{tid}/history").json()["payments"] == []          # nothing was recorded
    ok = owner.post(url, json={**body, "cash_received_confirmed": True})
    assert ok.status_code == 200 and ok.json()["verification"] == "owner_recorded"


# a payment can never be more than what is due
def test_payment_cannot_exceed_the_due_amount(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    tenant = actor()
    tid = onboard(owner, tenant.phone)["tenancy_id"]
    accept_all(tenant)
    owner.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
    due = tenant.get(f"/api/v1/tenancies/{tid}/bill").json()["summary"]["total_due_paise"]
    url = f"/api/v1/owner/tenancies/{tid}/payments/cash"
    r = owner.post(url, json={"amount": str(due // 100 + 1), "idempotency_key": "over-" + tid})
    assert r.status_code == 422 and r.json()["error"]["details"]["due_paise"] == due
    assert tenant.post(f"/api/v1/tenant/tenancies/{tid}/payments/checkout", json={"amount": str(due // 100 + 1), "idempotency_key": "over2-" + tid}).status_code == 422
    assert owner.post(url, json={"amount": str(due // 100), "idempotency_key": "exact-" + tid}).status_code == 200            # exactly the due is fine
    again = owner.post(url, json={"amount": str(due // 100), "idempotency_key": "exact-" + tid})
    assert again.status_code == 200                                                                                          # a retry returns the same payment
    assert owner.post(url, json={"amount": "1", "idempotency_key": "none-left-" + tid}).status_code == 422                    # nothing is due any more


def test_renter_asks_one_owner_to_vacate_and_the_place_becomes_vacant(actor):
    owner_a, owner_b = actor(roles=("owner",)), actor(roles=("owner",))
    for o in (owner_a, owner_b):
        pay_subscription(o)
    renter, stranger = actor(), actor()
    ta = onboard(owner_a, renter.phone)["tenancy_id"]
    tb = onboard(owner_b, renter.phone)["tenancy_id"]                     # the same renter rents from two owners
    accept_all(renter)
    ask = {"move_out_date": (TODAY + timedelta(days=10)).isoformat(), "reason": "Moving to another city"}
    assert stranger.post(f"/api/v1/tenancies/{ta}/vacate-request", json=ask).status_code == 404
    assert renter.post(f"/api/v1/tenancies/{ta}/vacate-request", json={**ask, "move_out_date": (TODAY - timedelta(days=1)).isoformat()}).status_code == 422
    r = renter.post(f"/api/v1/tenancies/{ta}/vacate-request", json=ask)
    assert r.status_code == 200 and r.json()["status"] == "requested", r.text
    vid = r.json()["id"]
    assert renter.post(f"/api/v1/tenancies/{ta}/vacate-request", json=ask).status_code == 409
    # only the owner of THAT place hears about it
    assert [x["id"] for x in owner_a.get("/api/v1/owner/vacate-requests").json()["items"]] == [vid]
    assert owner_b.get("/api/v1/owner/vacate-requests").json()["items"] == []
    assert owner_a.get("/api/v1/owner/dashboard").json()["metrics"]["vacate_pending"] == 1
    assert any(i["template"] == "vacate_requested" for i in owner_a.get("/api/v1/me/notifications", params={"role": "owner"}).json()["items"])
    assert not any(i["template"] == "vacate_requested" for i in owner_b.get("/api/v1/me/notifications", params={"role": "owner"}).json()["items"])
    assert owner_b.post(f"/api/v1/owner/vacate-requests/{vid}/decide", json={"action": "approve"}).status_code in (403, 404)
    assert renter.post(f"/api/v1/owner/vacate-requests/{vid}/decide", json={"action": "approve"}).status_code in (403, 404)   # the renter cannot approve their own
    rentals = {x["id"]: x for x in renter.get("/api/v1/tenant/rentals").json()["items"]}
    assert rentals[ta]["vacate"]["status"] == "requested" and rentals[tb]["vacate"] is None

    # decline keeps the rental and tells the renter; the renter can ask again
    assert owner_a.post(f"/api/v1/owner/vacate-requests/{vid}/decide", json={"action": "decline", "note": "Please clear the dues first"}).status_code == 200
    assert renter.get(f"/api/v1/tenancies/{ta}/vacate-request").json()["request"]["status"] == "declined"
    assert any(i["template"] == "vacate_declined" for i in renter.get("/api/v1/tenant/updates").json()["items"])
    v2 = renter.post(f"/api/v1/tenancies/{ta}/vacate-request", json=ask).json()["id"]
    assert renter.post(f"/api/v1/vacate-requests/{v2}/cancel").status_code == 200
    v3 = renter.post(f"/api/v1/tenancies/{ta}/vacate-request", json=ask).json()["id"]

    # approve: the rental ends for the renter, the place is vacant for the owner, the other rental is untouched
    ok = owner_a.post(f"/api/v1/owner/vacate-requests/{v3}/decide", json={"action": "approve", "end_date": (TODAY + timedelta(days=10)).isoformat(),
                                                                          "deposit_note": "Deposit returned after checking the house"})
    assert ok.status_code == 200 and ok.json()["status"] == "approved", ok.text
    assert owner_a.post(f"/api/v1/owner/vacate-requests/{v3}/decide", json={"action": "decline"}).status_code == 409
    rentals = {x["id"]: x for x in renter.get("/api/v1/tenant/rentals").json()["items"]}
    assert rentals[ta]["status"] == "ended" and rentals[tb]["status"] == "active"
    assert owner_a.get("/api/v1/owner/vacate-requests").json()["items"] == []
    assert any(i["template"] == "tenancy_closed" for i in renter.get("/api/v1/tenant/updates").json()["items"])
    # a renter with a live rental still cannot close the account
    assert renter.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 409


def test_owner_hands_the_account_to_another_number_who_must_pay_first(actor):
    old = actor(roles=("owner",))
    pay_subscription(old)
    renter, heir, stranger = actor(), actor(), actor()
    tid = onboard(old, renter.phone)["tenancy_id"]
    accept_all(renter)
    pre = old.get("/api/v1/owner/close-preview").json()
    assert pre["renters"] == 1 and pre["can_transfer"] is True
    assert old.post("/api/v1/owner/transfer", json={"phone": old.phone}).status_code == 422             # not to himself
    assert old.post("/api/v1/owner/transfer", json={"phone": renter.phone}).status_code == 409           # not to a renter of the place
    other_owner = actor(roles=("owner",))
    assert old.post("/api/v1/owner/transfer", json={"phone": other_owner.phone}).status_code == 409      # already has an owner account of their own
    old.auto_otp = False
    assert old.post("/api/v1/owner/transfer", json={"phone": heir.phone}).status_code == 403             # needs the one-time code
    old.auto_otp = True
    r = old.post("/api/v1/owner/transfer", json={"phone": heir.phone})
    assert r.status_code == 200 and r.json()["status"] == "completed", r.text

    # the old owner has no access any more; the account (places, renter, history) is the new owner's
    assert old.get("/api/v1/owner/close-preview").status_code in (403, 404)
    me = heir.get("/api/v1/me").json()
    acc = me["owner_accounts"][0]
    assert acc["role"] == "owner" and acc["state"] == "read_only" and acc["verification"] == "rejected"      # must pay (and give their own details) first
    assert heir.get("/api/v1/owner/close-preview", headers={"X-Owner-Account": acc["owner_account_id"]}).json()["renters"] == 1
    blocked = heir.post("/api/v1/owner/tenancies", headers={"X-Owner-Account": acc["owner_account_id"]},
                        json={"property_id": old._pid, "unit_identifier": "Z-1", "tenant_name": "New Renter", "tenant_mobile": stranger.phone,
                           "monthly_rent": "5000", "due_day": 5, "start_date": M0.isoformat(), "security_deposit": "1000", "end_date": END})
    assert blocked.status_code in (402, 409) and blocked.json()["error"]["code"] in ("SUBSCRIPTION_REQUIRED", "OWNER_DETAILS_REQUIRED"), blocked.text
    # once the new owner gives their own details and pays, they can use everything that was handed over
    assert heir.put("/api/v1/owner/verification", json={"legal_name": "Heir Owner", "pan": "HEIRX1234Z", "address": "2 New Street, Madurai",
                                                         "proof_type": "property_tax", "proof_ref": "PT-HEIR-1", "declare": True}).status_code == 200
    pay_subscription(heir)
    assert heir.get("/api/v1/me").json()["owner_accounts"][0]["state"] == "active"
    # the renter was told and now sees the new owner's name
    assert any(i["template"] == "owner_transferred" for i in renter.get("/api/v1/tenant/updates").json()["items"])
    assert renter.get("/api/v1/tenant/rentals").json()["items"][0]["owner_name"] == "Test User"
    # the old owner can now close his account, because nothing is left under him
    assert old.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 200
    assert renter.get("/api/v1/tenant/rentals").json()["items"][0]["status"] == "active"


def test_transfer_to_a_number_that_has_not_signed_up_yet_completes_on_first_sign_in(actor):
    old = actor(roles=("owner",))
    pay_subscription(old)
    renter = actor()
    onboard(old, renter.phone)
    accept_all(renter)
    phone = new_phone()
    assert old.post("/api/v1/owner/transfer", json={"phone": phone}).json()["status"] == "waiting"
    assert old.post("/api/v1/owner/transfer", json={"phone": new_phone()}).status_code in (403, 404)       # old owner already has no access
    heir = actor(phone=phone)                                                                                 # signs in for the first time
    acc = heir.get("/api/v1/me").json()["owner_accounts"]
    assert len(acc) == 1 and acc[0]["role"] == "owner" and acc[0]["state"] == "read_only"


def test_owner_who_does_not_transfer_closes_all_rentals_with_the_account(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    renter = actor()
    onboard(owner, renter.phone)
    accept_all(renter)
    assert owner.post("/api/v1/me/close-account", json={"confirm": "DELETE"}).status_code == 409           # rentals still live
    assert owner.post("/api/v1/me/close-account", json={"confirm": "DELETE", "close_rentals": True}).status_code == 200
    assert renter.get("/api/v1/tenant/rentals").json()["items"][0]["status"] == "ended"
    assert any(i["template"] == "tenancy_closed" for i in renter.get("/api/v1/tenant/updates").json()["items"])


def test_text_made_for_a_request_follows_the_language_on_screen_not_the_old_stored_one(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    renter = actor()
    onboard(owner, renter.phone)
    accept_all(renter)
    me = renter.get("/api/v1/me").json()
    assert renter.put("/api/v1/me/profile", json={"full_name": "Test User", "preferred_language": "ta", "version": me["version"]}).status_code == 200
    # the stored choice is Tamil, but the app is showing English: the bell must be English
    def bell(lang):
        h = {"X-App-Language": lang} if lang else {}
        return renter.get("/api/v1/me/notifications", params={"role": "tenant"}, headers=h).json()["items"]
    en = [i["text"] for i in bell("en")]
    ta = [i["text"] for i in bell("ta")]
    assert en and all(not any("஀" <= ch <= "௿" for ch in t) for t in en), en            # no Tamil letters
    assert ta and any("஀" <= ch <= "௿" for t in ta for ch in t), ta
    assert [i["text"] for i in bell(None)] == ta                                                   # no header: the stored preference, as before
    assert [i["text"] for i in bell("xx")] == ta                                                   # an unknown code is ignored
