"""Scanning a renter's ID card, agreement or visiting card to suggest their name and mobile number. The text reader is replaced by a fake that returns
what each test says the photo contains; what is tested is the rules: what comes back, what is NOT kept, and who may use it. Requires PostgreSQL."""
from __future__ import annotations

import hashlib

import pytest

from .conftest import pay_subscription
from .test_owner_docs import FakeEngine, photo

AADHAAR = "Government of India\nRavi Kumar\nDOB: 12/03/1990\nMale\n4821 5530 7196\n"
AGREEMENT = "RENTAL AGREEMENT between Mr. Anand Raj (the Lessor) and Mrs. Kavya Iyer, mobile 98765 43210 (hereinafter called the Tenant)."


@pytest.fixture
def engine(monkeypatch):
    from app.modules import owner_docs
    eng = FakeEngine()
    monkeypatch.setattr(owner_docs, "get_engine", lambda: eng)
    return eng


def scan(owner, data: bytes, name="card.jpg", mime="image/jpeg"):
    return owner.c.post("/api/v1/owner/renter-scan", headers=owner.h(), files={"file": (name, data, mime)})


def test_an_agreement_gives_the_tenant_and_the_number_as_suggestions(actor, engine):
    owner = actor(roles=("owner",))
    img = photo()
    engine.text[hashlib.sha256(img).hexdigest()] = AGREEMENT
    r = scan(owner, img)
    assert r.status_code == 200, r.text
    assert r.json() == {"name": "KAVYA IYER", "mobile": "9876543210", "found": True}


def test_an_id_card_number_is_never_returned_and_the_photo_and_text_are_not_kept(actor, engine, sql):
    owner = actor(roles=("owner",))
    img = photo()
    engine.text[hashlib.sha256(img).hexdigest()] = AADHAAR
    before = {t: sql(f"SELECT count(*) FROM {t}")[0][0] for t in ("owner_documents", "audit_events", "request_idempotency")}
    r = scan(owner, img)
    assert r.status_code == 200
    body = r.json()
    assert body == {"name": "RAVI KUMAR", "mobile": None, "found": True}
    assert "4821" not in r.text and "7196" not in r.text                           # the Aadhaar number is nowhere in the reply
    assert sql("SELECT count(*) FROM owner_documents")[0][0] == before["owner_documents"]       # no photo or text is stored
    assert sql("SELECT count(*) FROM audit_events WHERE after::text ILIKE '%4821%' OR before::text ILIKE '%4821%'")[0][0] == 0


def test_a_photo_with_nothing_readable_says_so_instead_of_guessing(actor, engine):
    owner = actor(roles=("owner",))
    img = photo()
    engine.text[hashlib.sha256(img).hexdigest()] = "Government of India\nUnique Identification Authority of India"
    assert scan(owner, img).json() == {"name": None, "mobile": None, "found": False}
    assert scan(owner, photo()).json()["found"] is False                           # a photo the reader returns nothing for


def test_only_real_photos_of_a_sensible_size_are_accepted(actor, engine):
    owner = actor(roles=("owner",))
    assert scan(owner, b"this is not a photo").status_code == 422
    assert scan(owner, photo(200, 200)).status_code == 422                          # too small to read
    too_big = scan(owner, b"x" * (6 * 1024 * 1024 + 10))
    assert too_big.status_code == 422 and too_big.json()["error"]["fields"][0]["code"] == "too_large"


def test_a_renter_cannot_use_it_and_signed_out_callers_cannot_either(actor, engine, client):
    renter = actor(roles=("tenant",))
    assert scan(renter, photo()).status_code in (401, 403)
    assert client.post("/api/v1/owner/renter-scan", files={"file": ("a.jpg", photo(), "image/jpeg")}).status_code in (401, 403)


def test_scanning_is_limited_so_it_cannot_be_used_as_a_free_text_reader(actor, engine):
    owner = actor(roles=("owner",))
    img = photo()
    codes = [scan(owner, img).status_code for _ in range(32)]
    assert codes[:30] == [200] * 30 and codes[-1] == 429


def test_when_the_reader_fails_the_owner_is_told_to_type_the_details(actor, monkeypatch):
    from app.modules import owner_docs

    class Broken:
        def read_text(self, image):
            raise RuntimeError("tesseract is not installed")
    monkeypatch.setattr(owner_docs, "get_engine", lambda: Broken())
    owner = actor(roles=("owner",))
    r = scan(owner, photo())
    assert r.status_code == 503 and r.json()["error"]["code"] == "PROVIDER_ERROR"
    assert "tesseract" not in r.text                                                # the technical reason is not shown
