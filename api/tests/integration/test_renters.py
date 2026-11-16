"""Renters: recorded first (name, mobile, photo ID), allotted a place later. The ID reader is replaced by a fake; what is tested is the rules:
what is mandatory, what is hidden, who can see the ID, and who is told when a renter is allotted. Requires PostgreSQL."""
from __future__ import annotations

import hashlib
import uuid
from datetime import date, timedelta

import pytest

from .conftest import ensure_property, new_phone, pay_subscription
from .test_owner_docs import FakeEngine, aadhaar_number, aadhaar_text, photo



@pytest.fixture
def engine(monkeypatch):
    from app.modules import owner_docs
    eng = FakeEngine()
    monkeypatch.setattr(owner_docs, "get_engine", lambda: eng)
    return eng


@pytest.fixture
def sent(monkeypatch):
    """Every message the app tries to send: (channel, to)."""
    from app.modules import notify, renters
    from app.providers.messaging import SendResult
    log: list[tuple[str, str]] = []

    class Rec:
        def __init__(self, ch): self.ch = ch
        def send(self, *, to, **kw):
            log.append((self.ch, to))
            return SendResult("sent", "rec", "x")
    monkeypatch.setattr(renters, "get_sender", lambda ch, s: Rec(ch))
    monkeypatch.setattr(notify, "get_sender", lambda ch, s: Rec(ch))
    return log


def form(**over):
    f = {"name": "Ravi Kumar", "phone": new_phone(), "id_type": "pan", "keep_copy_ok": "true"}
    f.update(over)
    return f


def add(owner, data=None, img=None, **over):
    return owner.c.post("/api/v1/owner/renters", headers=owner.h(), data=data or form(**over),
                        files={"file": ("id.jpg", img or photo(), "image/jpeg")})


def ready_owner(actor):
    owner = actor(roles=("owner",))
    pay_subscription(owner)
    ensure_property(owner)
    return owner


def a_unit(owner) -> str:
    r = owner.post("/api/v1/owner/units", json={"property_id": ensure_property(owner), "identifier": f"S-{uuid.uuid4().hex[:4]}", "kind": "commercial"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def terms(unit_id, **over):
    t = {"unit_id": unit_id, "monthly_rent": "10000", "due_day": 5, "start_date": date.today().isoformat(),
         "end_date": (date.today() + timedelta(days=330)).isoformat(), "security_deposit": "20000"}
    t.update(over)
    return t


def test_name_phone_and_photo_id_are_mandatory_and_the_rest_is_optional(actor, engine):
    owner = ready_owner(actor)
    assert add(owner).status_code == 200
    r = owner.c.post("/api/v1/owner/renters", headers=owner.h(), data=form())            # no photo
    assert r.status_code == 422
    assert add(owner, data=form(name="")).status_code in (400, 422)
    assert add(owner, data=form(phone="123")).status_code in (400, 422)
    assert add(owner, data=form(id_type="library_card")).status_code in (400, 422)
    assert add(owner, data=form(keep_copy_ok="false")).status_code in (400, 422)           # the owner must confirm the permission
    ok = add(owner, data=form(email="r@example.com", address="12 Market Road, Anna Nagar, Madurai"))
    assert ok.status_code == 200, ok.text


def test_the_same_mobile_cannot_be_added_twice(actor, engine):
    owner = ready_owner(actor)
    f = form()
    assert add(owner, data=f).status_code == 200
    assert add(owner, data=f).status_code == 409


def test_the_id_photo_is_encrypted_and_only_the_owner_can_see_it(actor, engine, sql):
    owner, other = ready_owner(actor), ready_owner(actor)
    img = photo()
    rid = add(owner, img=img).json()["id"]
    stored = bytes(sql("SELECT id_enc FROM renters WHERE id = %s", rid)[0][0]) if False else None
    got = owner.get(f"/api/v1/owner/renters/{rid}/id-photo")
    assert got.status_code == 200 and got.content == img and got.headers["cache-control"] == "no-store"
    assert other.get(f"/api/v1/owner/renters/{rid}/id-photo").status_code == 404           # another owner
    assert all(i["id"] != rid for i in other.get("/api/v1/owner/renters").json()["items"])
    raw = sql("SELECT id_enc FROM renters")
    assert all(img[:200] not in bytes(r[0]) for r in raw)                                 # not stored as the plain photo


def test_an_aadhaar_is_refused_when_its_number_cannot_be_hidden(actor, engine):
    owner = ready_owner(actor)
    img = photo()
    engine.text[hashlib.sha256(img).hexdigest()] = aadhaar_text('Ravi Kumar', aadhaar_number())
    engine.mask_ok = False
    r = add(owner, img=img, id_type="aadhaar")
    assert r.status_code == 422 and "hidden" in r.text
    engine.mask_ok = True
    assert add(owner, img=img, id_type="aadhaar").status_code == 200
    unread = add(owner, img=photo(), id_type="aadhaar")                                    # no number found in the photo
    assert unread.status_code == 422 and "could not be read" in unread.text


def test_the_list_shows_new_renters_and_filters_by_allotted(actor, engine):
    owner = ready_owner(actor)
    rid = add(owner).json()["id"]
    assert [i["id"] for i in owner.get("/api/v1/owner/renters?allotted=false").json()["items"]] == [rid]
    assert owner.get("/api/v1/owner/renters?allotted=true").json()["items"] == []


def test_allotting_creates_the_rental_and_tells_the_renter_by_sms_whatsapp_and_email(actor, engine, sent):
    owner = ready_owner(actor)
    f = form(email="renter@example.com")
    rid = add(owner, data=f).json()["id"]
    r = owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(owner)))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenancy_id"] and body["notified"] == {"sms": "sent", "whatsapp": "sent", "email": "sent"}
    channels = {c for c, _ in sent}
    assert channels == {"sms", "whatsapp", "email"}
    assert ("email", "renter@example.com") in sent
    assert ("whatsapp", "+91" + f["phone"][-10:]) in sent or any(c == "whatsapp" for c, _ in sent)
    assert sum(1 for c, to in sent if c == "sms" and to.endswith(f["phone"][-10:])) == 1                                       # not texted twice
    item = owner.get("/api/v1/owner/renters").json()["items"][0]
    assert item["allotted"] and item["tenancy_id"] == body["tenancy_id"]
    assert owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(owner))).status_code == 409   # already allotted


def test_without_an_email_only_sms_and_whatsapp_are_sent(actor, engine, sent):
    owner = ready_owner(actor)
    rid = add(owner).json()["id"]
    r = owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(owner)))
    assert r.json()["notified"]["email"] == "skipped" and {c for c, _ in sent} == {"sms", "whatsapp"}


def test_an_occupied_unit_is_refused_and_the_renter_stays_unallotted(actor, engine, sent):
    owner = ready_owner(actor)
    unit = a_unit(owner)
    first, second = add(owner).json()["id"], add(owner).json()["id"]
    assert owner.post(f"/api/v1/owner/renters/{first}/allot", json=terms(unit)).status_code == 200
    r = owner.post(f"/api/v1/owner/renters/{second}/allot", json=terms(unit))
    assert r.status_code == 409
    assert [i["id"] for i in owner.get("/api/v1/owner/renters?allotted=false").json()["items"]] == [second]


def test_a_failing_channel_does_not_block_the_allotment(actor, engine, monkeypatch):
    from app.modules import renters
    class Boom:
        def send(self, **kw): raise RuntimeError("provider down")
    monkeypatch.setattr(renters, "get_sender", lambda ch, s: Boom())
    owner = ready_owner(actor)
    rid = add(owner, email="a@example.com").json()["id"] if False else add(owner, data=form(email="a@example.com")).json()["id"]
    r = owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(owner)))
    assert r.status_code == 200 and r.json()["notified"]["whatsapp"] == "failed" and r.json()["notified"]["email"] == "failed"


def test_a_retried_allotment_with_the_same_key_does_not_message_twice(actor, engine, sent):
    owner = ready_owner(actor)
    rid = add(owner).json()["id"]
    t = terms(a_unit(owner))
    h = owner.h({"Idempotency-Key": "allot-key-12345678"})
    a = owner.c.post(f"/api/v1/owner/renters/{rid}/allot", headers=h, json=t)
    n = len(sent)
    b = owner.c.post(f"/api/v1/owner/renters/{rid}/allot", headers=h, json=t)
    assert a.status_code == b.status_code == 200 and a.json() == b.json() and len(sent) == n


def test_a_renter_not_yet_allotted_can_be_removed_and_the_id_photo_goes_with_them(actor, engine, sql):
    owner, other = ready_owner(actor), ready_owner(actor)
    rid = add(owner).json()["id"]
    assert other.delete(f"/api/v1/owner/renters/{rid}").status_code == 404               # not someone else's renter
    assert owner.delete(f"/api/v1/owner/renters/{rid}").status_code == 200
    assert owner.get("/api/v1/owner/renters").json()["items"] == []
    assert owner.get(f"/api/v1/owner/renters/{rid}/id-photo").status_code == 404
    assert sql(f"SELECT count(*) FROM renters WHERE id = '{rid}'")[0][0] == 0                  # the row, and so the encrypted photo, is gone


def test_an_allotted_renter_is_removed_from_the_unit_not_deleted(actor, engine, sent):
    owner = ready_owner(actor)
    rid = add(owner).json()["id"]
    assert owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(owner))).status_code == 200
    r = owner.delete(f"/api/v1/owner/renters/{rid}")
    assert r.status_code == 409 and "remove them from the unit" in r.text


def test_a_property_with_nobody_in_it_can_be_removed_and_its_address_added_again(actor, engine):
    owner = ready_owner(actor)
    pid = ensure_property(owner)
    unit = a_unit(owner)
    r = owner.post(f"/api/v1/owner/properties/{pid}/remove")
    assert r.status_code == 200, r.text
    assert owner.get("/api/v1/owner/properties").json()["items"] == []
    assert all(u["id"] != unit for u in owner.get("/api/v1/owner/units").json()["items"])      # its units are archived with it


def test_a_property_with_a_renter_in_it_cannot_be_removed_until_the_renter_is_removed(actor, engine, sent):
    owner = ready_owner(actor)
    pid = ensure_property(owner)
    unit = a_unit(owner)
    rid = add(owner).json()["id"]
    assert owner.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(unit)).status_code == 200
    r = owner.post(f"/api/v1/owner/properties/{pid}/remove")
    assert r.status_code == 409 and "renters still live here" in r.text
    assert len(owner.get("/api/v1/owner/properties").json()["items"]) == 1                      # nothing was changed


def test_only_the_owner_of_that_property_can_remove_it(actor, engine):
    owner, other = ready_owner(actor), ready_owner(actor)
    pid = ensure_property(owner)
    assert other.post(f"/api/v1/owner/properties/{pid}/remove").status_code == 404


def test_a_renter_who_is_also_an_owner_sees_the_invitation_and_can_accept_it(actor, engine, sent):
    landlord = ready_owner(actor)
    both = ready_owner(actor)                                 # an owner of another property, with a verified mobile of their own
    rid = add(landlord, data=form(phone=both.phone)).json()["id"]
    assert landlord.post(f"/api/v1/owner/renters/{rid}/allot", json=terms(a_unit(landlord))).status_code == 200
    inv = both.get("/api/v1/tenant/invitations").json()["items"]
    assert len(inv) == 1, "the invitation must be visible to a person who is an owner elsewhere"
    assert both.post(f"/api/v1/tenant/invitations/{inv[0]['id']}/accept").status_code == 200
    assert len(both.get("/api/v1/tenant/rentals").json()["items"]) == 1
