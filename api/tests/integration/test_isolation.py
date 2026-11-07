"""Who can see whose property data. Three situations:
 1. a stranger (another owner / another renter / a Both user) tries every endpoint that takes an id;
 2. a renter moves out and a NEW renter takes the same unit (and the old renter moves to another owner);
 3. one owner account managed by two people (a second membership), and access ending when it is revoked."""
from __future__ import annotations

import json
import uuid
from datetime import date

from .conftest import pay_subscription
from .test_api_flows import accept_all, onboard

TODAY = date.today()
M0 = TODAY.replace(day=1)
SECRET = "SECRET-NOTE-7f3a"          # text that must never reach anybody but the two parties of the tenancy
SECRET_NAME = "Zebulon Quartermain"   # the renter's name as the owner typed it


def _setup_victim(actor):
    """Owner A with one renter, one bill, a cash payment, a receipt, a note and a dispute."""
    a = actor(roles=("owner",), name="Owner Alpha")
    pay_subscription(a)
    t = actor(roles=("tenant",), name=SECRET_NAME)
    ta = onboard(a, t.phone, ident="ALPHA-1", deposit="20000")["tenancy_id"]
    accept_all(t)
    a.post(f"/api/v1/owner/tenancies/{ta}/invoices", params={"month": M0.isoformat()})
    pay = a.post(f"/api/v1/owner/tenancies/{ta}/payments/cash", json={"amount": "3000", "idempotency_key": "iso-" + ta}).json()
    note = a.post(f"/api/v1/tenancies/{ta}/notes", json={"target_type": "tenancy", "target_id": ta, "body": SECRET}).json()
    dis = t.post(f"/api/v1/tenancies/{ta}/disputes", json={"target_type": "payment", "target_id": pay["id"], "reason": SECRET})
    return a, t, ta, pay, note, dis.json() if dis.status_code == 200 else {}


def _ids(sql, ta, pay):
    receipt = sql("SELECT id FROM receipts WHERE payment_id = %s", pay["id"])[0][0]
    line = sql("SELECT l.id FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id WHERE i.tenancy_id = %s LIMIT 1", ta)[0][0]
    unit = sql("SELECT unit_id FROM tenancies WHERE id = %s", ta)[0][0]
    return str(receipt), str(line), str(unit)


def _probes(ta, pay, note, dis, receipt, line, unit):
    """(method, path, body) for every endpoint that takes a tenancy / payment / receipt / note / dispute / unit id."""
    z = str(uuid.UUID(int=0))
    pid, nid = pay["id"], note.get("id", z)
    did = dis.get("id", dis.get("dispute_id", z))
    cash = {"amount": "1", "idempotency_key": "x" * 12}
    return [
        ("GET", f"/api/v1/owner/tenancies/{ta}", None), ("PATCH", f"/api/v1/owner/tenancies/{ta}", {"version": 1, "monthly_rent": "1"}),
        ("PUT", f"/api/v1/owner/tenancies/{ta}/contact", {"name": "Hacked"}),
        ("PUT", f"/api/v1/owner/tenancies/{ta}/charge-config", [{"category": "misc", "enabled": True}]),
        ("GET", f"/api/v1/owner/tenancies/{ta}/charge-suggestions?month={M0.isoformat()}", None),
        ("POST", f"/api/v1/owner/tenancies/{ta}/charges", {"period_month": M0.isoformat(), "category": "misc", "amount": "1"}),
        ("POST", f"/api/v1/owner/tenancies/{ta}/contact-proposals", {"field": "secondary_mobile", "new_value": "9876543210"}),
        ("POST", f"/api/v1/owner/tenancies/{ta}/deposit", {"type": "received", "amount": "1", "idempotency_key": "d" * 12}),
        ("POST", f"/api/v1/owner/tenancies/{ta}/end?end_date={date(TODAY.year + 1, 1, 1).isoformat()}", None),
        ("POST", f"/api/v1/owner/tenancies/{ta}/invoices?month={M0.isoformat()}", None),
        ("POST", f"/api/v1/owner/tenancies/{ta}/payments/cash", cash),
        ("POST", f"/api/v1/owner/payments/{pid}/reverse", {"reason": "intruder"}), ("POST", f"/api/v1/owner/payments/{pid}/confirm-transfer", {}),
        ("POST", f"/api/v1/owner/invoice-lines/{line}/adjust", {"new_total": "1", "reason": "intruder"}),
        ("POST", f"/api/v1/owner/disputes/{did}/resolve", {"resolution": "intruder", "status": "resolved"}),
        ("POST", f"/api/v1/owner/units/{unit}/archive", None),
        ("GET", f"/api/v1/tenancies/{ta}/bill", None), ("GET", f"/api/v1/tenancies/{ta}/deposit", None),
        ("GET", f"/api/v1/tenancies/{ta}/history", None), ("GET", f"/api/v1/tenancies/{ta}/statement", None),
        ("GET", f"/api/v1/tenancies/{ta}/notes", None), ("GET", f"/api/v1/tenancies/{ta}/disputes", None),
        ("POST", f"/api/v1/tenancies/{ta}/notes", {"target_type": "tenancy", "target_id": ta, "body": "intruder"}),
        ("POST", f"/api/v1/tenancies/{ta}/disputes", {"target_type": "payment", "target_id": pid, "reason": "intruder"}),
        ("POST", f"/api/v1/tenancies/{ta}/charge-submissions", {"period_month": M0.isoformat(), "category": "electricity", "amount": "1"}),
        ("PATCH", f"/api/v1/notes/{nid}", {"body": "defaced"}),
        ("GET", f"/api/v1/payments/{pid}", None), ("GET", f"/api/v1/receipts/{receipt}", None),
        ("POST", f"/api/v1/tenant/payments/{pid}/ack", {"response": "disputed", "reason": "x"}),
        ("POST", f"/api/v1/tenant/payments/{pid}/refresh", None),
        ("POST", f"/api/v1/tenant/tenancies/{ta}/payments/checkout", {"amount": "1", "idempotency_key": "c" * 12}),
        ("POST", f"/api/v1/tenant/tenancies/{ta}/payments/manual-transfer", {"amount": "1", "paid_on": TODAY.isoformat(), "reference": "REF12345", "idempotency_key": "m" * 12}),
    ]


def test_strangers_cannot_reach_another_ownerss_data(actor, sql):
    a, t, ta, pay, note, dis = _setup_victim(actor)
    receipt, line, unit = _ids(sql, ta, pay)
    # sanity: the two parties CAN see it
    assert a.get(f"/api/v1/tenancies/{ta}/bill").status_code == 200 and t.get(f"/api/v1/tenancies/{ta}/bill").status_code == 200
    assert t.get(f"/api/v1/receipts/{receipt}").status_code == 200

    b = actor(roles=("owner",), name="Owner Beta"); pay_subscription(b)
    u = actor(roles=("tenant",), name="Other Renter"); onboard(b, u.phone, ident="BETA-1"); accept_all(u)
    both = actor(roles=("owner", "tenant"), name="Both User"); pay_subscription(both)
    onboard(b, both.phone, ident="BETA-2"); accept_all(both)
    strangers = {"other owner": b, "other renter": u, "Both user": both}

    leaks, allowed = [], (402, 403, 404)      # 422 here would mean the probe never reached the permission check
    for who, s in strangers.items():
        for method, path, body in _probes(ta, pay, note, dis, receipt, line, unit):
            r = s.c.request(method, path, headers=s.h(), **({"json": body} if body is not None else {}))
            text = r.text
            if r.status_code not in allowed or SECRET in text or SECRET_NAME in text or "ALPHA-1" in text:
                leaks.append((who, method, path, r.status_code))
        # the same call with a forged owner header must not switch accounts either
        r = s.get("/api/v1/owner/tenancies", headers={"X-Owner-Account": sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", a.id)[0][0].__str__()})
        if r.status_code not in (403, 404, 402):
            leaks.append((who, "GET", "/owner/tenancies with A's owner header", r.status_code))
    assert not leaks, f"another person could reach this data: {leaks}"

    # list screens and the data export of strangers never contain A's data
    for who, s in strangers.items():
        for path in ["/api/v1/owner/tenancies?status=all", "/api/v1/owner/units?status=all", "/api/v1/owner/disputes", "/api/v1/owner/properties",
                     "/api/v1/owner/dashboard", "/api/v1/owner/dashboard/collected", "/api/v1/owner/dashboard/pending", "/api/v1/owner/dashboard/overdue",
                     "/api/v1/owner/dashboard/units", "/api/v1/tenant/rentals", "/api/v1/tenant/invitations", "/api/v1/me", "/api/v1/me/export"]:
            r = s.get(path)
            assert SECRET not in r.text and SECRET_NAME not in r.text and "ALPHA-1" not in r.text and ta not in r.text, f"{who} sees Alpha's data in {path}"
    # search cannot be used to dig it out either
    for q in (SECRET_NAME, "ALPHA", "Zebulon", "%", "_"):
        r = b.get("/api/v1/owner/tenancies", params={"q": q, "status": "all"})
        assert r.status_code == 200 and SECRET_NAME not in r.text and "ALPHA-1" not in r.text


def test_renter_moves_out_and_a_new_renter_takes_the_same_unit(actor, sql):
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    old = actor(roles=("tenant",), name="Old Renter"); new = actor(roles=("tenant",), name="New Renter")
    t1 = onboard(a, old.phone, ident="SAME-1", deposit="10000")["tenancy_id"]; accept_all(old)
    a.post(f"/api/v1/owner/tenancies/{t1}/invoices", params={"month": M0.isoformat()})
    a.post(f"/api/v1/tenancies/{t1}/notes", json={"target_type": "tenancy", "target_id": t1, "body": SECRET})
    pay = a.post(f"/api/v1/owner/tenancies/{t1}/payments/cash", json={"amount": "2000", "idempotency_key": "mv-" + t1}).json()
    receipt = sql("SELECT id FROM receipts WHERE payment_id = %s", pay["id"])[0][0]
    assert a.post(f"/api/v1/owner/tenancies/{t1}/end", params={"end_date": date(TODAY.year + 1, 1, 1).isoformat()}).status_code == 200

    # the SAME shop number at the SAME address goes to a new renter
    t2 = onboard(a, new.phone, ident="SAME-1", deposit="5000")["tenancy_id"]; accept_all(new)
    assert t2 != t1
    # the new renter sees only their own tenancy and none of the old renter's records
    rentals = new.get("/api/v1/tenant/rentals").json()["items"]
    assert [r["id"] for r in rentals] == [t2]
    for path in (f"/api/v1/tenancies/{t1}/bill", f"/api/v1/tenancies/{t1}/history", f"/api/v1/tenancies/{t1}/statement",
                 f"/api/v1/tenancies/{t1}/notes", f"/api/v1/tenancies/{t1}/deposit", f"/api/v1/tenancies/{t1}/disputes",
                 f"/api/v1/payments/{pay['id']}", f"/api/v1/receipts/{receipt}"):
        r = new.get(path)
        assert r.status_code in (403, 404) and SECRET not in r.text and "Old Renter" not in r.text, path
    for path in (f"/api/v1/tenancies/{t2}/bill", f"/api/v1/tenancies/{t2}/history", f"/api/v1/tenancies/{t2}/notes"):
        r = new.get(path)
        assert r.status_code == 200 and SECRET not in r.text and "Old Renter" not in r.text, path
    # the new renter's own statement does not carry the old renter's payments, deposit or name
    st = new.get(f"/api/v1/tenancies/{t2}/statement").text
    assert "Old Renter" not in st and pay["receipt_number"] not in st
    # the old renter keeps their OWN record, but cannot see the new renter
    assert old.get(f"/api/v1/tenancies/{t1}/statement").status_code == 200
    assert [r["id"] for r in old.get("/api/v1/tenant/rentals").json()["items"]] == [t1]
    for path in (f"/api/v1/tenancies/{t2}/bill", f"/api/v1/tenancies/{t2}/history", f"/api/v1/tenancies/{t2}/statement", f"/api/v1/tenancies/{t2}/notes"):
        r = old.get(path)
        assert r.status_code in (403, 404) and "New Renter" not in r.text, path
    assert old.post(f"/api/v1/tenancies/{t2}/notes", json={"target_type": "tenancy", "target_id": t2, "body": "hi"}).status_code in (403, 404)
    # an ended tenancy stays the old renter's own record: they may still settle what they owe on it (by design), but only on it
    assert old.post(f"/api/v1/tenant/tenancies/{t1}/payments/checkout", json={"amount": "1", "idempotency_key": "e" * 12}).status_code == 200
    assert new.post(f"/api/v1/tenant/tenancies/{t1}/payments/checkout", json={"amount": "1", "idempotency_key": "f" * 12}).status_code == 404
    assert old.post(f"/api/v1/tenant/tenancies/{t2}/payments/checkout", json={"amount": "1", "idempotency_key": "g" * 12}).status_code == 404


def test_renter_who_moves_to_another_owner_keeps_the_two_records_apart(actor, sql):
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    b = actor(roles=("owner",), name="Owner Beta"); pay_subscription(b)
    t = actor(roles=("tenant",), name="Mover")
    ta = onboard(a, t.phone, ident="A-1")["tenancy_id"]; accept_all(t)
    a.post(f"/api/v1/tenancies/{ta}/notes", json={"target_type": "tenancy", "target_id": ta, "body": SECRET})
    a.post(f"/api/v1/owner/tenancies/{ta}/end", params={"end_date": date(TODAY.year + 1, 1, 1).isoformat()})
    tb = onboard(b, t.phone, ident="B-1")["tenancy_id"]; accept_all(t)
    # the new owner sees only the new tenancy: nothing from the old landlord (bills, notes, name of the old shop)
    for path in (f"/api/v1/owner/tenancies/{ta}", f"/api/v1/tenancies/{ta}/bill", f"/api/v1/tenancies/{ta}/history", f"/api/v1/tenancies/{ta}/notes"):
        assert b.get(path).status_code == 404, path
    assert SECRET not in b.get(f"/api/v1/tenancies/{tb}/notes").text and "A-1" not in b.get(f"/api/v1/owner/tenancies/{tb}").text
    # and the old owner cannot see the new one
    for path in (f"/api/v1/owner/tenancies/{tb}", f"/api/v1/tenancies/{tb}/bill", f"/api/v1/tenancies/{tb}/notes"):
        assert a.get(path).status_code == 404, path
    # the renter sees both, each with its own owner
    rentals = t.get("/api/v1/tenant/rentals").json()["items"]
    assert {r["id"] for r in rentals} == {ta, tb}


def test_one_owner_account_managed_by_two_people(actor, sql):
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    t = actor(roles=("tenant",), name=SECRET_NAME)
    ta = onboard(a, t.phone, ident="TEAM-1")["tenancy_id"]; accept_all(t)
    a.post(f"/api/v1/tenancies/{ta}/notes", json={"target_type": "tenancy", "target_id": ta, "body": SECRET})
    b = actor(roles=("owner",), name="Owner Beta"); pay_subscription(b)
    onboard(b, actor(roles=("tenant",)).phone, ident="BETA-9")
    mgr = actor(roles=("owner",), name="Manager Mona"); pay_subscription(mgr)      # has an owner account of their own
    owner_a = sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", a.id)[0][0]
    assert mgr.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404            # not a member yet: nothing

    sql("INSERT INTO owner_memberships(owner_account_id, user_id, role) VALUES (%s, %s, 'manager')", owner_a, mgr.id)
    hdr = {"X-Owner-Account": str(owner_a)}
    # while a member, they work on Alpha's account when they pick it …
    assert [x["id"] for x in mgr.get("/api/v1/owner/tenancies", headers=hdr).json()["items"]] == [ta]
    assert mgr.get(f"/api/v1/tenancies/{ta}/bill").status_code == 200
    # … and see only their OWN properties when they pick their own account: Alpha's data does not bleed across
    own = mgr.get("/api/v1/owner/tenancies")
    assert SECRET_NAME not in own.text and ta not in own.text
    # they never gain access to Beta's account
    owner_b = sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", b.id)[0][0]
    assert mgr.get("/api/v1/owner/tenancies", headers={"X-Owner-Account": str(owner_b)}).status_code == 404
    # a manager cannot change the subscription (only owner / co-owner can)
    assert mgr.post("/api/v1/subscription/checkout", headers=hdr, json={"plan_code": "business", "idempotency_key": "k-" + uuid.uuid4().hex}).status_code in (403, 404)

    # access ends the moment the membership is revoked
    sql("UPDATE owner_memberships SET status = 'revoked' WHERE owner_account_id = %s AND user_id = %s", owner_a, mgr.id)
    assert mgr.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404
    assert mgr.get(f"/api/v1/tenancies/{ta}/bill").status_code == 404
    assert mgr.get("/api/v1/owner/tenancies", headers=hdr).status_code == 404


def test_a_renter_sees_only_their_own_occupied_unit(actor, sql):
    """The renter gets: their unit, its address, their bills/payments/deposit, the shared notes, and the owner's display name + badge.
    Nothing else about the owner (phone, internal ids, legal details) or the owner's other units, properties and renters."""
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    mine, other = actor(roles=("tenant",), name="My Renter"), actor(roles=("tenant",), name="Zed Other Renter")
    tm = onboard(a, mine.phone, ident="MINE-1")["tenancy_id"]
    onboard(a, other.phone, ident="OTHER-UNIT-9")
    # before accepting: only the owner's name, the unit and the badge — no address, city, rent or owner phone
    inv = mine.get("/api/v1/tenant/invitations").json()["items"][0]
    assert set(inv) == {"id", "owner_name", "unit", "created_at", "owner_verification", "your_mobile"}
    accept_all(mine)
    a.post(f"/api/v1/owner/tenancies/{tm}/invoices", params={"month": M0.isoformat()})
    pay = a.post(f"/api/v1/owner/tenancies/{tm}/payments/cash", json={"amount": "1000", "idempotency_key": "pv-" + tm}).json()
    receipt = sql("SELECT id FROM receipts WHERE payment_id = %s", pay["id"])[0][0]
    rental = mine.get("/api/v1/tenant/rentals").json()["items"][0]
    assert not ({"owner_mobile", "owner_account_id", "primary_user_id"} & set(rental))
    assert rental["owner_name"] == "Owner Alpha" and rental["identifier"] == "MINE-1" and rental["owner_ref"]
    bodies = {p: mine.get(p).text for p in [
        "/api/v1/tenant/rentals", "/api/v1/tenant/invitations", "/api/v1/me", "/api/v1/me/export",
        f"/api/v1/tenancies/{tm}/bill", f"/api/v1/tenancies/{tm}/history", f"/api/v1/tenancies/{tm}/statement",
        f"/api/v1/tenancies/{tm}/deposit", f"/api/v1/tenancies/{tm}/notes", f"/api/v1/tenancies/{tm}/disputes", f"/api/v1/receipts/{receipt}"]}
    owner_id = str(sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", a.id)[0][0])
    for path, text in bodies.items():
        for forbidden in (a.phone, owner_id, "OTHER-UNIT-9", "Zed Other Renter", other.phone, "1 Test Street, Madurai", "ABCDE", "PT-TEST-001"):
            assert forbidden not in text, f"{path} shows the renter '{forbidden}'"
    # and the renter cannot list or open the owner's other units, properties or renters
    for path in ("/api/v1/owner/tenancies", "/api/v1/owner/units", "/api/v1/owner/properties", "/api/v1/owner/verification"):
        assert mine.get(path).status_code in (402, 403, 404), path


def test_only_declared_owner_numbers_can_co_own(actor, sql):
    """The subscriber declares up to 2 numbers in total. Only a person who signs in with a declared number becomes a co-owner."""
    from .conftest import new_phone
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    t = actor(roles=("tenant",), name="Alpha Renter")
    ta = onboard(a, t.phone, ident="CO-1")["tenancy_id"]; accept_all(t)
    partner_phone, outsider = new_phone(), actor(roles=("owner",), name="Not Declared"); pay_subscription(outsider)

    # nothing declared yet: nobody but the subscriber has access
    assert a.get("/api/v1/owner/owner-numbers").json()["owners"][0]["role"] == "owner"
    assert outsider.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404
    # at most 2 owner numbers in total (the subscriber + 1): three, or the subscriber's own number, are refused
    two = [{"phone": new_phone(), "relationship": "friend"}, {"phone": new_phone(), "relationship": "friend"}]
    r = a.put("/api/v1/owner/owner-numbers", json={"co_owners": two})
    assert r.status_code in (400, 422) and a.get("/api/v1/owner/owner-numbers").json()["declared"] == []
    assert a.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": a.phone, "relationship": "family"}]}).status_code in (400, 422)
    # the relationship is required, and must be one of: brother, sister, parent, son, daughter, friend, family
    some = new_phone()
    assert a.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": some}]}).status_code == 422
    for bad in ("cousin", "", "Brother ", "boss"):
        assert a.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": some, "relationship": bad}]}).status_code == 422, bad
    assert a.post("/api/v1/subscription/checkout", json={"plan_code": "growth", "idempotency_key": "rel-" + uuid.uuid4().hex,
                  "co_owners": [{"phone": some}]}).status_code == 422
    assert a.get("/api/v1/owner/owner-numbers").json()["declared"] == []

    # declare the partner at checkout (before they have signed up at all)
    out = a.post("/api/v1/subscription/checkout", json={"plan_code": "growth", "idempotency_key": "own-" + uuid.uuid4().hex, "co_owners": [{"phone": partner_phone, "relationship": "sister"}]})
    assert out.status_code == 200, out.text
    view = a.get("/api/v1/owner/owner-numbers").json()
    assert [d["phone"] for d in view["declared"]] == ["+91" + partner_phone] and view["declared"][0]["joined"] is False and view["slots_left"] == 0
    assert view["declared"][0]["relationship"] == "sister"                           # saved with the number
    assert outsider.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404           # a different number gets nothing

    # the partner signs in with that number → co-owner of the SAME account, sees the same renters
    partner = actor(phone=partner_phone, roles=("owner",), name="Partner Owner")
    me = partner.get("/api/v1/me").json()
    assert any(o["role"] == "co_owner" for o in me["owner_accounts"])
    owner_a = str(sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", a.id)[0][0])
    mine = partner.get("/api/v1/owner/tenancies", headers={"X-Owner-Account": owner_a}).json()["items"]
    assert [x["id"] for x in mine] == [ta]
    assert partner.get(f"/api/v1/tenancies/{ta}/bill").status_code == 200
    assert a.get("/api/v1/owner/owner-numbers").json()["declared"][0]["joined"] is True
    # a co-owner cannot change who the owners are, and the stranger is still locked out
    assert partner.put("/api/v1/owner/owner-numbers", json={"co_owners": []}, headers={"X-Owner-Account": owner_a}).status_code == 403
    assert outsider.get(f"/api/v1/owner/tenancies/{ta}").status_code == 404

    # removing the number ends access at once
    assert a.put("/api/v1/owner/owner-numbers", json={"co_owners": []}).status_code == 200
    assert partner.get(f"/api/v1/owner/tenancies/{ta}", headers={"X-Owner-Account": owner_a}).status_code == 404
    assert partner.get(f"/api/v1/tenancies/{ta}/bill").status_code == 404
    # re-declaring brings them back (their account already exists, so they join immediately)
    assert a.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": partner_phone, "relationship": "brother"}]}).status_code == 200
    assert partner.get(f"/api/v1/owner/tenancies/{ta}", headers={"X-Owner-Account": owner_a}).status_code == 200
    assert a.get("/api/v1/owner/owner-numbers").json()["declared"][0]["relationship"] == "brother"          # the new choice replaced the old one


def test_every_allowed_relationship_is_accepted(actor):
    from .conftest import new_phone
    a = actor(roles=("owner",), name="Owner Alpha"); pay_subscription(a)
    phone = new_phone()
    for rel in ("brother", "sister", "parent", "son", "daughter", "friend", "family"):
        r = a.put("/api/v1/owner/owner-numbers", json={"co_owners": [{"phone": phone, "relationship": rel}]})
        assert r.status_code == 200, (rel, r.text)
        assert r.json()["declared"][0]["relationship"] == rel


# every verification step needs a one-time code sent to the account's OWN mobile
def test_verification_steps_need_a_code_from_the_attached_phone(actor):
    from .conftest import GATED
    a = actor(roles=("owner",), identity=False)
    a.auto_otp = False
    body = {"consent": True, "notice_version": a.get("/api/v1/me/identity").json()["notice_version"]}
    # no code: refused, and the answer says a code is needed
    r = a.post("/api/v1/me/identity/start", json=body)
    assert r.status_code == 403 and r.json()["error"]["details"]["otp_required"] is True
    # a wrong code is refused
    assert a.post("/api/v1/me/identity/start", json={**body, "otp_code": "000000"}).status_code == 422
    # the code goes to the signed-in account's own number: the request names no destination, and it is masked in the answer
    sent = a.post("/api/v1/me/action-otp/request", json={"action": "identity"}).json()
    assert sent["sent_to"].endswith(a.phone[-4:])
    # a code for one step cannot approve another step
    c = actor(roles=("owner",), identity=False)
    c.auto_otp = False
    pay = c.post("/api/v1/me/action-otp/request", json={"action": "payout"}).json()["demo_code"]
    assert c.post("/api/v1/me/identity/start", json={**body, "otp_code": pay}).status_code == 422
    # someone else's code (sent to their own phone) cannot approve my step
    # the right code works exactly once
    ok = a.post("/api/v1/me/identity/start", json={**body, "otp_code": sent["demo_code"]})
    assert ok.status_code == 200 and ok.json()["status"] == "pending"
    # every step in the list refuses a missing code
    assert {v for v in GATED.values()} == {"identity", "owner_details", "property", "payout", "co_owner", "transfer"}
    for (method, url), _ in GATED.items():
        if url.endswith("checkout") or url.endswith("identity/start"):
            continue
        r = a.c.request(method, url, headers=a.h(), json={"co_owners": [], "display_masked": "xxxx1234", "declare": True,
                        "legal_name": "Test Owner", "pan": "ABCDE1234F", "address": "1 Test Street, Madurai", "proof_type": "property_tax",
                        "proof_ref": "PT-TEST-001", "city": "Madurai", "pincode": "625001"})
        assert r.status_code in (402, 403, 409, 422), (url, r.status_code)
        assert r.status_code != 200, url
