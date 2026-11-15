"""Automatic owner document check: PAN card + live selfie + the first and last page of the property deed.

No person reviews anything (docs/DECISIONS.md D-21, amended). The server reads the text on the photos and compares the selfie with the
photo on the PAN card using free, local engines (providers/docs.py). When every check passes, the owner's details and photo ID are
marked verified, and a property is marked verified when its address is found on the deed. Anything else is told to the owner so they can
fix it and try again, up to RG_DOC_MAX_TRIES_PER_DAY times a day.

This is a screening check, not proof: a photo cannot show that a document is genuine. The audit log records every attempt and its result.
Switched off unless RG_DOC_AUTO_APPROVE=true.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field

from ..core.auth import OwnerScope, owner_scope
from ..core.config import get_settings
from ..core.crypto import decrypt_bytes, encrypt_bytes, encrypt as _enc_pan, lookup_hash as _pan_hash, mask_pan as _mask_pan
from ..core.db import Db, get_db, transaction
from ..core.errors import AppError
from ..core.http import limiter
from ..domain import docmatch
from ..domain.validation import validate_address, validate_full_name
from ..providers import docs as docs_provider
from ..providers.docs import BadImage, get_engine      # (tests replace get_engine in THIS module)

router = APIRouter(prefix="/api/v1", tags=["owner-documents"])

KINDS = ("pan", "aadhaar", "selfie", "deed_first", "deed_last")      # the owner uploads a PAN card OR an Aadhaar card (front), never both needed
ID_KINDS = ("pan", "aadhaar")
MAX_BYTES = 6 * 1024 * 1024
MIN_SIDE = {"selfie": 300, "pan": 700, "aadhaar": 700, "deed_first": 700, "deed_last": 700}
AUTO_NOTE = "automatic document check"


def _enabled() -> None:
    if not get_settings().doc_auto_approve:
        raise AppError("NOT_FOUND")                  # the feature does not exist while it is switched off


def _phone(db: Db, user_id) -> str | None:
    return db.scalar("""SELECT value FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND removed_at IS NULL
                        ORDER BY is_primary DESC, created_at LIMIT 1""", u=user_id)


def owner_auto_verified(db: Db, owner_account_id) -> bool:
    return bool(db.scalar("SELECT 1 FROM owner_verifications WHERE owner_account_id = :o AND status = 'verified' AND review_note = :n",
                          o=owner_account_id, n=AUTO_NOTE))


@router.get("/owner/documents")
def list_documents(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    _enabled()
    rows = db.all("SELECT kind, created_at FROM owner_documents WHERE owner_account_id = :o", o=scope.owner_account_id)
    have = {r["kind"]: r["created_at"] for r in rows}
    return {"enabled": True, "items": [{"kind": k, "uploaded": k in have, "uploaded_at": have.get(k)} for k in KINDS],
            "verified": owner_auto_verified(db, scope.owner_account_id)}


@router.put("/owner/documents/{kind}")
def upload_document(kind: str, file: UploadFile = File(...), typed_number: str | None = Form(default=None),
                    scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    _enabled()
    if kind not in KINDS:
        raise AppError("NOT_FOUND")
    limiter.check(f"docup:{scope.user.id}", 40, 3600)
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise AppError("VALIDATION", "the photo is too large (6 MB at most)", fields=[{"field": "file", "code": "too_large"}])
    try:
        mime, w, h = docs_provider.inspect_image(data)
    except BadImage as e:
        raise AppError("VALIDATION", f"{e}: take a JPEG or PNG photo", fields=[{"field": "file", "code": "invalid_image"}]) from e
    if min(w, h) < MIN_SIDE[kind]:
        raise AppError("VALIDATION", "the photo is too small: move closer or use the camera's normal quality",
                       fields=[{"field": "file", "code": "too_small"}])
    stored, text_enc = data, None
    if kind == "aadhaar":
        # The full Aadhaar number must never be stored (only an authorised entity may): read it here, black out its first 8 digits in the
        # photo, and keep only the masked photo and the masked text.
        text, masked = get_engine().read_aadhaar(data)
        number = docmatch.find_aadhaar(text)
        if number is None:
            raise AppError("VALIDATION", "the Aadhaar number could not be read: photograph the FRONT of the card, whole, flat and sharp",
                           fields=[{"field": "file", "code": "aadhaar_unreadable"}])
        if re.sub(r"\D", "", typed_number or "") != number:           # the number typed in the form: compared here, never stored
            raise AppError("VALIDATION", "the Aadhaar number you typed does not match the card", fields=[{"field": "id_number", "code": "mismatch"}])
        if masked is None:
            raise AppError("VALIDATION", "the Aadhaar number could not be hidden automatically: try a sharper photo, or use the masked Aadhaar from the mAadhaar app",
                           fields=[{"field": "file", "code": "aadhaar_not_masked"}])
        stored, mime = masked, "image/jpeg"
        text_enc = encrypt_bytes(docmatch.mask_aadhaar_text(text, number).encode(), "doctext")
    db.exec("DELETE FROM owner_documents WHERE owner_account_id = :o AND kind = :k", o=scope.owner_account_id, k=kind)
    if kind in ID_KINDS:                                                  # one ID document at a time
        db.exec("DELETE FROM owner_documents WHERE owner_account_id = :o AND kind = ANY(:ks)", o=scope.owner_account_id, ks=list(ID_KINDS))
    db.exec("""INSERT INTO owner_documents(owner_account_id, kind, mime, content_enc, sha256, text_enc, uploaded_by, uploaded_phone)
               VALUES (:o, :k, :m, :c, :h, :t, :u, :p)""",
            o=scope.owner_account_id, k=kind, m=mime, c=encrypt_bytes(stored), h=hashlib.sha256(data).hexdigest(), t=text_enc, u=scope.user.id,
            p=_phone(db, scope.user.id))
    db.audit(scope.user.id, scope.owner_account_id, "owner_document.uploaded", "owner_account", scope.owner_account_id, after={"kind": kind})
    return {"kind": kind, "uploaded": True}


ProofKind = Literal["property_tax", "electricity_bill", "sale_deed", "rent_agreement", "gst", "other"]


class VerifyIn(BaseModel):
    legal_name: str = Field(max_length=100)
    signature: str = Field(max_length=100)          # the full name typed again on the signature page
    address: str = Field(max_length=1000)           # the owner's own address
    id_number: str = Field(default="", max_length=20)     # the PAN typed in the form (an Aadhaar number is checked when its card is uploaded and never sent here)
    proof_type: ProofKind                            # the property document named in the form (its pages are uploaded)
    proof_ref: str = Field(max_length=80)           # and its number
    declare: bool = False                            # "the documents I submitted are original and belong to me"


def _check(checks: list[dict], code: str, ok: bool, message: str) -> bool:
    checks.append({"code": code, "ok": ok, "message": message})
    return ok


@router.post("/owner/documents/verify")
def verify_documents(body: VerifyIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    _enabled()
    s = get_settings()
    if not body.declare:
        raise AppError("VALIDATION", "confirm that these are your own genuine documents", fields=[{"field": "declare", "code": "required"}])
    name = validate_full_name(body.legal_name, "legal_name")
    address = validate_address(body.address, required=True, field="address")
    if docmatch.name_similarity(name, body.signature) < 0.9:
        raise AppError("VALIDATION", "sign with your full name exactly as you typed it in the form", fields=[{"field": "signature", "code": "mismatch"}])
    proof_ref = body.proof_ref.strip()
    if not 3 <= len(proof_ref) <= 80:
        raise AppError("VALIDATION", "enter the property document number", fields=[{"field": "proof_ref", "code": "required"}])
    limiter.check(f"docverify:{scope.user.id}", s.doc_max_tries_per_day, 86400)
    phone = _phone(db, scope.user.id)
    checks: list[dict] = []

    rows = {r["kind"]: r for r in db.all("SELECT kind, content_enc, sha256, text_enc FROM owner_documents WHERE owner_account_id = :o", o=scope.owner_account_id)}
    id_kind = next((k for k in ID_KINDS if k in rows), None)
    missing = ([] if id_kind else ["pan or aadhaar"]) + [k for k in ("selfie", "deed_first", "deed_last") if k not in rows]
    if not _check(checks, "documents_missing", not missing, ("Upload all four photos first: " + ", ".join(missing)) if missing else "All four photos are uploaded."):
        return _finish(db, scope, "failed", checks, phone)

    used = (id_kind, "selfie", "deed_first", "deed_last")
    label = "PAN card" if id_kind == "pan" else "Aadhaar card"
    eng = get_engine()
    img = {k: decrypt_bytes(rows[k]["content_enc"]) for k in used}
    if id_kind == "pan":
        id_text = eng.read_text(img["pan"])
        pan = docmatch.find_pan(id_text)
        readable, region, born = pan is not None, docmatch.pan_name_region(id_text), docmatch.find_birth_date(id_text)
        id_enc, id_hash, id_masked = (_enc_pan(pan), _pan_hash(pan), _mask_pan(pan)) if pan else (None, None, None)
        typed_pan = re.sub(r"[^A-Z0-9]", "", body.id_number.upper())
    else:
        # the Aadhaar was read when it was uploaded and its number hidden: only the masked text and the last 4 digits exist
        id_text = decrypt_bytes(rows["aadhaar"]["text_enc"], "doctext").decode() if rows["aadhaar"]["text_enc"] else ""
        last4 = docmatch.aadhaar_last4(id_text)
        readable, region, born = last4 is not None, docmatch.aadhaar_name_region(id_text), docmatch.find_birth_date_or_year(id_text)
        id_enc, id_masked = None, (f"XXXX XXXX {last4}" if last4 else None)
        # no Aadhaar number is kept, not even a hash of it: duplicates are spotted by last 4 digits + name + year of birth
        id_hash = _pan_hash("AADHAAR|%s|%s|%s" % (last4, " ".join(sorted(docmatch.name_tokens(name))), born.year if born else "")) if last4 else None
    if _check(checks, f"{id_kind}_readable", readable, f"The {label} number was read." if readable else
              f"The {label} number could not be read: photograph the whole card flat, in good light, without glare."):
        name_ok = docmatch.name_in_text(name, region, s.doc_name_min)
        _check(checks, f"name_matches_{id_kind}", name_ok, f"The name you typed matches the {label}." if name_ok
               else f"The name you typed was not found on the {label}. Type it exactly as printed on the card.")
        if id_kind == "pan":
            _check(checks, "pan_number_matches", typed_pan == pan, "The PAN you typed matches the card." if typed_pan == pan
                   else "The PAN you typed does not match the number on the card photo.")
        if born is not None:
            _check(checks, "adult", docmatch.age_on(born, date.today()) >= 18, "The owner must be at least 18 years old.")

    score, problem = eng.face_score(img["selfie"], img[id_kind])
    if score is None:
        _check(checks, "face_found", False, "No face was found in your selfie: look straight at the camera in good light." if problem == "selfie"
               else f"No face was found on the {label} photo: photograph the whole card, close and sharp.")
    else:
        _check(checks, "face_match", score >= s.doc_face_min,
               f"Your selfie matches the photo on the {label}." if score >= s.doc_face_min
               else f"Your selfie does not match the photo on the {label}. Take it again facing the camera, in good light, without glasses or a cap.")

    deed_first, deed_last = eng.read_text(img["deed_first"]), eng.read_text(img["deed_last"])
    _check(checks, "deed_readable", docmatch.enough_text(deed_first) and docmatch.enough_text(deed_last, 8),
           "The deed pages were read." if docmatch.enough_text(deed_first) and docmatch.enough_text(deed_last, 8)
           else "The deed pages could not be read: photograph each page flat, whole and sharp.")
    deed = deed_first + "\n" + deed_last
    _check(checks, "name_matches_deed", docmatch.name_in_text(name, deed, s.doc_name_min),
           "Your name was found on the deed." if docmatch.name_in_text(name, deed, s.doc_name_min)
           else "Your name was not found on the deed pages. The first page must show you as owner.")

    # across all owners (row-level security hides other accounts, so this uses the system connection)
    hashes = [rows[k]["sha256"] for k in used]
    with transaction() as sdb:
        photo_dup = bool(sdb.scalar("SELECT 1 FROM owner_documents WHERE owner_account_id <> :o AND sha256 IN (:a, :b, :c, :d) LIMIT 1",
                                    o=scope.owner_account_id, a=hashes[0], b=hashes[1], c=hashes[2], d=hashes[3]))
        id_other_person = bool(id_hash and sdb.scalar("""SELECT 1 FROM owner_verifications v JOIN owner_accounts a ON a.id = v.owner_account_id
                                                         WHERE v.pan_hash = :p AND v.owner_account_id <> :o AND v.status IN ('submitted','verified')
                                                           AND a.primary_user_id <> :u LIMIT 1""",
                                                      p=id_hash, o=scope.owner_account_id, u=scope.user.id))
        same_person_account = sdb.scalar("""SELECT v.owner_account_id FROM owner_verifications v JOIN owner_accounts a ON a.id = v.owner_account_id
                                            WHERE v.pan_hash = :p AND v.owner_account_id <> :o AND v.status IN ('submitted','verified')
                                              AND v.copied_from_account IS NULL AND a.primary_user_id = :u LIMIT 1""",
                                         p=id_hash or "", o=scope.owner_account_id, u=scope.user.id)
    _check(checks, "photos_not_reused", not photo_dup, "These photos are not used on another account." if not photo_dup
           else "One of these photos is already used on another owner account.")
    if id_hash:
        _check(checks, f"{id_kind}_not_reused", not id_other_person, f"This {label} is not registered to another owner." if not id_other_person
               else f"This {label} is already registered to another owner account.")

    ok = all(c["ok"] for c in checks)
    if ok:
        # keep the deed text (encrypted) so a property can be matched to the deed when it is added
        for k, t in (("deed_first", deed_first), ("deed_last", deed_last)):
            db.exec("UPDATE owner_documents SET text_enc = :t WHERE owner_account_id = :o AND kind = :k",
                    t=encrypt_bytes(t.encode(), "doctext"), o=scope.owner_account_id, k=k)
        _approve(user_id=scope.user.id, owner=scope.owner_account_id, name=name, address=address, id_enc=id_enc, id_hash=id_hash, id_masked=id_masked,
                 method=f"{id_kind}_selfie_ocr", proof_type=body.proof_type, proof_ref=proof_ref, copied_from=same_person_account)
    return _finish(db, scope, "verified" if ok else "failed", checks, phone, ident=id_masked)


def _finish(db: Db, scope: OwnerScope, status: str, checks: list[dict], phone: str | None, ident: str | None = None) -> dict:
    db.audit(scope.user.id, scope.owner_account_id, f"owner_documents.{status}", "owner_account", scope.owner_account_id,
             after={"phone": phone, "id": ident, "failed": [c["code"] for c in checks if not c["ok"]]})
    return {"status": status, "checks": checks}


def _approve(*, user_id, owner, name: str, address: str, id_enc: str | None, id_hash: str | None, id_masked: str | None, method: str,
             proof_type: str, proof_ref: str, copied_from) -> None:
    """Mark the owner's details and photo ID verified. The signed-in role cannot do this (database triggers), so it uses the system connection."""
    s = get_settings()
    with transaction() as sdb:
        sdb.exec("""INSERT INTO owner_verifications(owner_account_id, legal_name, pan_enc, pan_hash, pan_masked, address, proof_type, proof_ref,
                                                    declared_at, status, reviewed_at, review_note, copied_from_account)
                    VALUES (:o, :n, :pe, :ph, :pm, :a, :pt, :r, now(), 'verified', now(), :note, :cf)
                    ON CONFLICT (owner_account_id) DO UPDATE SET legal_name = :n, pan_enc = :pe, pan_hash = :ph, pan_masked = :pm, address = :a,
                      proof_type = :pt, proof_ref = :r, declared_at = now(), status = 'verified', reviewed_at = now(), review_note = :note,
                      copied_from_account = :cf, updated_at = now()""",
                 o=owner, n=name, pe=id_enc, ph=id_hash, pm=id_masked, a=address, pt=proof_type, r=proof_ref, note=AUTO_NOTE, cf=copied_from)
        sdb.exec("UPDATE identity_verifications SET status = 'withdrawn', updated_at = now() WHERE user_id = :u AND status IN ('pending', 'manual_review')", u=user_id)
        if not sdb.scalar("SELECT 1 FROM identity_verifications WHERE user_id = :u AND status = 'verified' AND (expires_at IS NULL OR expires_at > now())", u=user_id):
            sdb.exec("UPDATE identity_verifications SET status = 'withdrawn', updated_at = now() WHERE user_id = :u AND status = 'verified'", u=user_id)   # expired
            sdb.exec("""INSERT INTO identity_verifications(user_id, status, provider, method, face_matched, name_matched, consent_version, expires_at,
                                                           reviewed_at, review_note)
                        VALUES (:u, 'verified', 'selfcheck', :m, true, true, 'doc-v1', now() + make_interval(days => :d), now(), :note)""",
                     u=user_id, d=s.kyc_validity_days, note=AUTO_NOTE, m=method)


def check_property_against_deed(db: Db, owner_account_id, v: dict) -> None:
    """Called when a property is added. For an owner who passed the automatic check, the property's address (or pincode) must appear on
    the deed pages that were uploaded; otherwise the owner is told to correct the address instead of waiting for a review that never comes."""
    s = get_settings()
    if not s.doc_auto_approve or not owner_auto_verified(db, owner_account_id):
        return
    rows = db.all("SELECT text_enc FROM owner_documents WHERE owner_account_id = :o AND kind IN ('deed_first', 'deed_last') AND text_enc IS NOT NULL",
                  o=owner_account_id)
    text = "\n".join(decrypt_bytes(r["text_enc"], "doctext").decode() for r in rows)
    if len(rows) < 2 or not docmatch.address_in_text(v["address"], v.get("pincode"), text):
        raise AppError("DEED_ADDRESS_MISMATCH", "The property address was not found on the deed pages you uploaded. Enter the address as it is written on the deed, "
                       "or upload the deed of this property.", fields=[{"field": "address", "code": "deed_mismatch"}])
