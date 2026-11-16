"""Safe retries for data-entry requests (offline capture and sync). A request that carries an Idempotency-Key is done ONCE: a repeat of the same
key returns the same reply and changes nothing, even when two copies arrive at the same moment. Requires PostgreSQL."""
from __future__ import annotations

import threading
import uuid
from datetime import date

from .conftest import ensure_property, new_phone, pay_subscription
from .test_api_flows import END, M0, accept_all

TODAY = date.today()


def key() -> str:
    return "k-" + uuid.uuid4().hex


def renter_body(pid, ident, phone=None, **over):
    body = {"property_id": pid, "unit_identifier": ident, "tenant_name": "Ravi Kumar", "tenant_mobile": phone or new_phone(), "monthly_rent": "10000",
            "due_day": 5, "start_date": M0.isoformat(), "end_date": END, "security_deposit": "1000"}
    body.update(over)
    return body


def with_key(k):
    return {"Idempotency-Key": k}


def owner_with_property(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    return owner, ensure_property(owner)


def tenancy_count(sql, owner_id):
    return sql("SELECT count(*) FROM tenancies t JOIN owner_accounts a ON a.id = t.owner_account_id WHERE a.primary_user_id = %s", owner_id)[0][0]


def test_a_renter_sent_twice_with_the_same_key_is_added_once_and_the_reply_is_the_same(actor, sql):
    owner, pid = owner_with_property(actor)
    body, k = renter_body(pid, "S-01"), key()
    first = owner.post("/api/v1/owner/tenancies", json=body, headers=with_key(k))
    again = owner.post("/api/v1/owner/tenancies", json=body, headers=with_key(k))         # the first reply was lost: the phone sends it again
    assert first.status_code == 200 and again.status_code == 200, (first.text, again.text)
    assert again.json() == first.json()                                                  # the very same reply, not a "unit is occupied" error
    assert tenancy_count(sql, owner.id) == 1


def test_without_a_key_nothing_changes_for_old_clients(actor):
    owner, pid = owner_with_property(actor)
    body = renter_body(pid, "S-01")
    assert owner.post("/api/v1/owner/tenancies", json=body).status_code == 200
    second = owner.post("/api/v1/owner/tenancies", json=body)
    assert second.status_code == 409 and second.json()["error"]["code"] == "UNIT_OCCUPIED"     # as before


def test_the_same_key_with_a_different_request_is_refused(actor, sql):
    owner, pid = owner_with_property(actor)
    k = key()
    assert owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01"), headers=with_key(k)).status_code == 200
    other = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-02"), headers=with_key(k))
    assert other.status_code == 409 and other.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert tenancy_count(sql, owner.id) == 1                                             # a key cannot be used to slip another change through


def test_two_copies_arriving_at_the_same_moment_create_one_renter(actor, sql):
    owner, pid = owner_with_property(actor)
    body, k = renter_body(pid, "S-01"), key()
    replies: list = []
    def send():
        replies.append(owner.post("/api/v1/owner/tenancies", json=body, headers=with_key(k)))
    threads = [threading.Thread(target=send) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert [r.status_code for r in replies] == [200] * 6, [r.text for r in replies]
    assert len({r.json()["tenancy_id"] for r in replies}) == 1                           # all six got the one tenancy
    assert tenancy_count(sql, owner.id) == 1


def test_a_failed_request_is_not_remembered_so_the_corrected_entry_can_be_sent_again(actor, sql):
    owner, pid = owner_with_property(actor)
    first_renter = renter_body(pid, "S-01")
    assert owner.post("/api/v1/owner/tenancies", json=first_renter).status_code == 200
    k = key()
    clash = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01"), headers=with_key(k))      # that unit is taken
    assert clash.status_code == 409
    fixed = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-02"), headers=with_key(k))      # the owner picks another unit
    assert fixed.status_code == 200, fixed.text                                          # the same key still works: the failure left nothing behind
    assert tenancy_count(sql, owner.id) == 2


def test_keys_belong_to_one_person_two_owners_can_use_the_same_text(actor):
    a, pa = owner_with_property(actor)
    b, pb = owner_with_property(actor)
    k = key()
    ra = a.post("/api/v1/owner/tenancies", json=renter_body(pa, "S-01"), headers=with_key(k))
    rb = b.post("/api/v1/owner/tenancies", json=renter_body(pb, "S-01"), headers=with_key(k))
    assert ra.status_code == 200 and rb.status_code == 200
    assert ra.json()["tenancy_id"] != rb.json()["tenancy_id"]                            # never the other person's reply


def test_a_bad_key_is_refused(actor):
    owner, pid = owner_with_property(actor)
    for bad in ("short", "has space in it", "x" * 81, "bad/char/here"):
        r = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-09"), headers=with_key(bad))
        assert r.status_code == 422, (bad, r.text)


def test_a_unit_added_twice_with_the_same_key_is_added_once(actor, sql):
    owner, pid = owner_with_property(actor)
    body, k = {"property_id": pid, "identifier": "Shop 7", "kind": "commercial"}, key()
    a = owner.post("/api/v1/owner/units", json=body, headers=with_key(k))
    b = owner.post("/api/v1/owner/units", json=body, headers=with_key(k))
    assert a.status_code == 200 and b.status_code == 200, (a.text, b.text)
    assert a.json()["id"] == b.json()["id"]
    assert sql("SELECT count(*) FROM units WHERE property_id = %s AND identifier = 'Shop 7'", pid)[0][0] == 1
    assert owner.post("/api/v1/owner/units", json=body).status_code == 409               # without the key it is still a duplicate, as before


def test_a_charge_added_twice_with_the_same_key_is_charged_once(actor):
    owner, pid = owner_with_property(actor)
    tid = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01")).json()["tenancy_id"]
    body, k = {"period_month": M0.isoformat(), "category": "water", "amount": "250"}, key()
    one = owner.post(f"/api/v1/owner/tenancies/{tid}/charges", json=body, headers=with_key(k))
    two = owner.post(f"/api/v1/owner/tenancies/{tid}/charges", json=body, headers=with_key(k))
    assert one.status_code == 200 and two.status_code == 200, (one.text, two.text)
    assert two.json() == one.json()
    bill = owner.get(f"/api/v1/tenancies/{tid}/bill", params={"month": M0.isoformat()}).json()
    water = [ln for ln in str(bill).split("'category': ") if ln.startswith("'water'")]
    assert len(water) == 1, bill                                                         # one water line, not two


def test_a_note_sent_twice_with_the_same_key_is_one_note(actor):
    owner, pid = owner_with_property(actor)
    renter = actor()
    tid = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01", renter.phone)).json()["tenancy_id"]
    accept_all(renter)
    body, k = {"target_type": "tenancy", "target_id": tid, "body": "Water meter changed on Monday"}, key()
    assert renter.post(f"/api/v1/tenancies/{tid}/notes", json=body, headers=with_key(k)).status_code == 200
    assert renter.post(f"/api/v1/tenancies/{tid}/notes", json=body, headers=with_key(k)).status_code == 200
    mine = [n for n in owner.get(f"/api/v1/tenancies/{tid}/notes").json()["items"] if n["body"] == "WATER METER CHANGED ON MONDAY" or n["body"] == body["body"]]
    assert len(mine) == 1, mine


def test_a_profile_save_replayed_after_it_was_applied_is_not_a_conflict(actor):
    user = actor()
    me = user.get("/api/v1/me").json()
    body, k = {"full_name": "Ravi Kumar", "address": "12 Market Road, Madurai", "preferred_language": "en", "version": me["version"]}, key()
    first = user.put("/api/v1/me/profile", json=body, headers=with_key(k))
    again = user.put("/api/v1/me/profile", json=body, headers=with_key(k))               # the version moved on, but this is the same request
    assert first.status_code == 200 and again.status_code == 200, (first.text, again.text)
    stale = user.put("/api/v1/me/profile", json=body, headers=with_key(key()))           # a genuinely stale save is still refused
    assert stale.status_code == 409


def test_a_renter_message_sent_twice_with_the_same_key_reaches_the_owner_once(actor, sql):
    owner, pid = owner_with_property(actor)
    renter = actor()
    tid = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01", renter.phone)).json()["tenancy_id"]
    accept_all(renter)
    k = key()
    for _ in range(2):
        assert renter.post(f"/api/v1/tenant/tenancies/{tid}/messages", json={"text": "Tap is leaking", "lang": "en"}, headers=with_key(k)).status_code == 200
    assert sql("SELECT count(*) FROM renter_messages WHERE tenancy_id = %s", tid)[0][0] == 1


def test_the_tenancy_edit_can_be_replayed(actor):
    owner, pid = owner_with_property(actor)
    tid = owner.post("/api/v1/owner/tenancies", json=renter_body(pid, "S-01")).json()["tenancy_id"]
    version = owner.get(f"/api/v1/owner/tenancies/{tid}").json()["tenancy"]["version"]
    body, k = {"version": version, "monthly_rent": "12000"}, key()
    assert owner.patch(f"/api/v1/owner/tenancies/{tid}", json=body, headers=with_key(k)).status_code == 200
    again = owner.patch(f"/api/v1/owner/tenancies/{tid}", json=body, headers=with_key(k))            # same version as before, now stale: still fine
    assert again.status_code == 200, again.text
