"""Automatic owner document check: PAN card + selfie + deed pages, no person involved.
The text reader and the face comparison are replaced by a fake that returns what each test says the photos contain; what is tested
is the rules, the stored data and the database protections. (The real engines are exercised by tests/unit/test_docmatch.py and by hand.)"""
from __future__ import annotations

import hashlib
import io
import itertools

import pytest

from .conftest import new_phone, pay_subscription, property_body

_pan_n = itertools.count(1000)
_seed = itertools.count(1)


def photo(w: int = 800, h: int = 800) -> bytes:
    """A valid, unique JPEG (random noise, so every call has its own hash)."""
    import numpy as np
    from PIL import Image
    rng = np.random.default_rng(next(_seed))
    buf = io.BytesIO()
    Image.fromarray(rng.integers(0, 255, (h, w, 3), dtype="uint8")).save(buf, "JPEG", quality=70)
    return buf.getvalue()


class FakeEngine:
    def __init__(self) -> None:
        self.text: dict[str, str] = {}
        self.score: float | None = 0.8
        self.problem = ""
        self.mask_ok = True

    def read_aadhaar(self, image: bytes):
        return self.read_text(image), (image if self.mask_ok else None)      # (text, the photo with the number hidden: here unchanged)

    def read_text(self, image: bytes) -> str:
        return self.text.get(hashlib.sha256(image).hexdigest(), "")

    def face_score(self, selfie: bytes, card: bytes):
        return self.score, self.problem


def pan_text(name: str, pan: str) -> str:
    return f"INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number\n{pan}\nName\n{name.upper()}\nFather's Name\nSURESH SHARMA\nDate of Birth\n12/05/1980"


def deed_text(name: str, address: str = "12 Market Road, Anna Nagar, Madurai 625020") -> str:
    return (f"SALE DEED executed at Madurai on this day between the vendor and {name.upper()} the purchaser of the property situated at {address}. "
            "The vendor hereby sells and conveys the entire property together with all rights, easements and appurtenances to the purchaser "
            "for the agreed consideration, free of all encumbrances, and the purchaser shall hold it absolutely and forever.")


@pytest.fixture
def engine(monkeypatch, sql):
    from app.core.config import get_settings
    from app.modules import owner_docs
    eng = FakeEngine()
    monkeypatch.setattr(owner_docs, "get_engine", lambda: eng)
    monkeypatch.setattr(get_settings(), "doc_auto_approve", True)
    sql("UPDATE system_flags SET value = 'on' WHERE key = 'doc_auto_verify'")
    yield eng
    sql("UPDATE system_flags SET value = 'off' WHERE key = 'doc_auto_verify'")


def new_owner(actor, name="Ramesh Kumar Sharma"):
    return actor(roles=("owner",), name=name, identity=False)


def upload(owner, kind: str, data: bytes, name="photo.jpg"):
    return owner.c.put(f"/api/v1/owner/documents/{kind}", headers=owner.h(), files={"file": (name, data, "image/jpeg")})


def prepare(owner, eng: FakeEngine, name="Ramesh Kumar Sharma", pan=None, address=None):
    """Upload the four photos and tell the fake engine what they contain. Every owner gets its own street number: the tests share one database."""
    n = next(_pan_n)
    pan = pan or f"ABCPE{n}F"
    owner.street = f"{n} Market Road, Anna Nagar"                     # what the owner will type as the property address
    address = address or f"{owner.street}, Madurai 625020"
    imgs = {"pan": photo(), "selfie": photo(500, 500), "deed_first": photo(), "deed_last": photo()}
    eng.text[hashlib.sha256(imgs["pan"]).hexdigest()] = pan_text(name, pan)
    eng.text[hashlib.sha256(imgs["deed_first"]).hexdigest()] = deed_text(name, address)
    eng.text[hashlib.sha256(imgs["deed_last"]).hexdigest()] = "Signed and delivered in the presence of the witnesses below at Madurai."
    for k, d in imgs.items():
        assert upload(owner, k, d).status_code == 200
    return pan, imgs


def verify(owner, name="Ramesh Kumar Sharma", declare=True):
    return owner.post("/api/v1/owner/documents/verify", json={"legal_name": name, "address": "5 Gandhi Street, Madurai", "declare": declare})


def failed_codes(r) -> set[str]:
    return {c["code"] for c in r.json()["checks"] if not c["ok"]}


def test_all_checks_pass_and_the_owner_is_verified_with_no_reviewer(actor, engine, sql):
    o = new_owner(actor)
    prepare(o, engine)
    r = verify(o)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "verified" and not failed_codes(r)
    row = sql("SELECT status, review_note, proof_type FROM owner_verifications WHERE owner_account_id = (SELECT id FROM owner_accounts WHERE primary_user_id = %s)", o.id)[0]
    assert row == ("verified", "automatic document check", "sale_deed")
    assert o.get("/api/v1/me/identity").json()["status"] == "verified"          # the photo-ID gate for adding a property is open
    assert o.get("/api/v1/owner/documents").json()["verified"] is True
    # the photos are stored encrypted: neither the JPEG header nor the PAN text appears in the table
    blob = bytes(sql("SELECT content_enc FROM owner_documents WHERE uploaded_by = %s AND kind = 'pan'", o.id)[0][0])
    assert b"\xff\xd8\xff" not in blob[:20]


def test_property_is_verified_automatically_when_its_address_is_on_the_deed(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    assert verify(o).json()["status"] == "verified"
    pay_subscription(o)
    r = o.post("/api/v1/owner/properties", json=property_body(address=o.street, pincode="625020"))
    assert r.status_code == 200, r.text
    assert r.json()["verification_status"] == "verified" and r.json()["review_note"] is None or r.json()["verification_status"] == "verified"
    assert o.get("/api/v1/owner/properties").json()["items"][0]["verification_status"] == "verified"


def test_a_property_that_is_not_on_the_deed_is_refused_not_left_waiting(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    assert verify(o).json()["status"] == "verified"
    pay_subscription(o)
    body = property_body(address="77 Elsewhere Lane, Teppakulam", pincode="625009")
    r = o.post("/api/v1/owner/properties", json=body)
    assert r.status_code == 422 and r.json()["error"]["code"] == "DEED_ADDRESS_MISMATCH"
    assert o.post("/api/v1/owner/properties/check", json=body).status_code == 422
    assert o.get("/api/v1/owner/properties").json()["items"] == []


def test_wrong_name_fails_and_nothing_is_verified(actor, engine, sql):
    o = new_owner(actor)
    prepare(o, engine, name="Someone Else Entirely")
    r = verify(o)
    assert r.json()["status"] == "failed"
    assert {"name_matches_pan", "name_matches_deed"} <= failed_codes(r)
    assert sql("SELECT status FROM owner_verifications WHERE owner_account_id = (SELECT id FROM owner_accounts WHERE primary_user_id = %s)", o.id)[0][0] == "submitted"
    assert o.get("/api/v1/me/identity").json()["status"] != "verified"


def test_face_that_does_not_match_fails(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    engine.score = 0.05
    r = verify(o)
    assert r.json()["status"] == "failed" and "face_match" in failed_codes(r)


def test_no_face_in_the_selfie_fails_with_a_helpful_message(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    engine.score, engine.problem = None, "selfie"
    r = verify(o)
    bad = [c for c in r.json()["checks"] if not c["ok"] and c["code"] == "face_found"]
    assert bad and "selfie" in bad[0]["message"]


def test_missing_photos_are_listed(actor, engine):
    o = new_owner(actor)
    assert upload(o, "pan", photo()).status_code == 200
    r = verify(o)
    assert r.json()["status"] == "failed" and failed_codes(r) == {"documents_missing"}


def test_the_same_photos_cannot_back_two_owners(actor, engine):
    a, b = new_owner(actor), new_owner(actor, "Meena Kumari Devi")
    pan, imgs = prepare(a, engine)
    assert verify(a).json()["status"] == "verified"
    for k, d in imgs.items():
        assert upload(b, k, d).status_code == 200                      # the same four files
    engine.text[hashlib.sha256(imgs["pan"]).hexdigest()] = pan_text("Meena Kumari Devi", pan)
    engine.text[hashlib.sha256(imgs["deed_first"]).hexdigest()] = deed_text("Meena Kumari Devi")
    r = verify(b, "Meena Kumari Devi")
    assert r.json()["status"] == "failed" and {"photos_not_reused", "pan_not_reused"} <= failed_codes(r)


def test_declaration_is_required_and_tries_are_limited(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    assert verify(o, declare=False).status_code == 422
    engine.score = 0.0
    for _ in range(5):
        assert verify(o).status_code == 200
    assert verify(o).status_code == 429                                  # RG_DOC_MAX_TRIES_PER_DAY = 5


def test_bad_uploads_are_refused(actor, engine):
    o = new_owner(actor)
    assert upload(o, "pan", b"not an image at all").status_code == 422
    assert upload(o, "pan", photo(200, 200)).status_code == 422          # too small to read
    assert upload(o, "passport", photo()).status_code == 404             # unknown kind
    assert upload(o, "pan", b"\x00" * (6 * 1024 * 1024 + 10)).status_code in (413, 422)


def test_only_the_owner_account_can_see_its_photos(actor, engine, sql):
    a, b = new_owner(actor), new_owner(actor, "Meena Kumari Devi")
    prepare(a, engine)
    assert all(not i["uploaded"] for i in b.get("/api/v1/owner/documents").json()["items"])
    from .test_rls import as_app
    acct_b = str(sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", b.id)[0][0])
    with as_app({"app.user_id": str(b.id), "app.owner_ids": acct_b}) as c:      # b's database session cannot read a's rows
        assert c.execute("SELECT count(*) FROM owner_documents").fetchone()[0] == 0


# ───────── Aadhaar instead of PAN ─────────
def aadhaar_number() -> str:
    from app.domain import docmatch
    base = f"2345678{next(_pan_n):04d}"
    return base + docmatch.verhoeff_check_digit(base)


def aadhaar_text(name: str, number: str) -> str:
    return f"Government of India\n{name.upper()}\nDOB: 12/05/1980\nMale\n{number[:4]} {number[4:8]} {number[8:]}\nVID: 9999 8888 7777 6666"


def prepare_aadhaar(owner, eng: FakeEngine, name="Ramesh Kumar Sharma", number=None):
    number = number or aadhaar_number()
    n = next(_pan_n)
    owner.street = f"{n} Gandhi Road, Anna Nagar"
    imgs = {"aadhaar": photo(), "selfie": photo(500, 500), "deed_first": photo(), "deed_last": photo()}
    eng.text[hashlib.sha256(imgs["aadhaar"]).hexdigest()] = aadhaar_text(name, number)
    eng.text[hashlib.sha256(imgs["deed_first"]).hexdigest()] = deed_text(name, f"{owner.street}, Madurai 625020")
    eng.text[hashlib.sha256(imgs["deed_last"]).hexdigest()] = "Signed and delivered in the presence of the witnesses below at Madurai."
    for k, d in imgs.items():
        assert upload(owner, k, d).status_code == 200, k
    return number, imgs


def test_aadhaar_can_replace_the_pan_and_its_number_is_never_stored(actor, engine, sql):
    o = new_owner(actor)
    number, _ = prepare_aadhaar(o, engine)
    r = verify(o)
    assert r.status_code == 200 and r.json()["status"] == "verified", r.text
    assert {c["code"] for c in r.json()["checks"]} >= {"aadhaar_readable", "name_matches_aadhaar", "face_match", "aadhaar_not_reused"}
    row = sql("SELECT status, pan_masked, pan_enc FROM owner_verifications WHERE owner_account_id = (SELECT id FROM owner_accounts WHERE primary_user_id = %s)", o.id)[0]
    assert row[0] == "verified" and row[1] == f"XXXX XXXX {number[8:]}" and row[2] is None
    # nowhere in the database is the full number: not in the stored text (decrypted), not in the audit log, not in owner_verifications
    from app.core.crypto import decrypt_bytes
    blob = sql("SELECT text_enc FROM owner_documents WHERE uploaded_by = %s AND kind = 'aadhaar'", o.id)[0][0]
    text = decrypt_bytes(blob, "doctext").decode()
    assert number not in text.replace(" ", "") and f"XXXX XXXX {number[8:]}" in text
    assert not sql("SELECT 1 FROM audit_events WHERE after::text LIKE %s", f"%{number}%")
    assert o.get("/api/v1/me/identity").json()["status"] == "verified"


def test_an_unreadable_or_invalid_aadhaar_is_refused_at_upload(actor, engine):
    o = new_owner(actor)
    img = photo()
    engine.text[hashlib.sha256(img).hexdigest()] = "Government of India\nRAMESH KUMAR SHARMA\n2345 6789 0123"        # wrong check digit
    r = upload(o, "aadhaar", img)
    assert r.status_code == 422 and "FRONT" in r.json()["error"]["message"]
    img2 = photo()
    engine.text[hashlib.sha256(img2).hexdigest()] = aadhaar_text("Ramesh Kumar Sharma", aadhaar_number())
    engine.mask_ok = False                                                         # the number was found but could not be hidden: never stored
    assert upload(o, "aadhaar", img2).status_code == 422
    assert all(not i["uploaded"] for i in o.get("/api/v1/owner/documents").json()["items"])


def test_only_one_id_document_is_kept_and_the_wrong_name_still_fails(actor, engine):
    o = new_owner(actor)
    prepare(o, engine)
    prepare_aadhaar(o, engine, name="Someone Else Entirely")                       # uploading the Aadhaar replaces the PAN
    items = {i["kind"]: i["uploaded"] for i in o.get("/api/v1/owner/documents").json()["items"]}
    assert items["aadhaar"] and not items["pan"]
    r = verify(o)
    assert r.json()["status"] == "failed" and "name_matches_aadhaar" in failed_codes(r)


def test_the_same_aadhaar_cannot_back_two_owners(actor, engine):
    a, b = new_owner(actor), new_owner(actor, "Ramesh Kumar Sharma")
    number, _ = prepare_aadhaar(a, engine)
    assert verify(a).json()["status"] == "verified"
    prepare_aadhaar(b, engine, number=number)                                      # same number, same name and year of birth, different photos
    r = verify(b)
    assert r.json()["status"] == "failed" and "aadhaar_not_reused" in failed_codes(r)
