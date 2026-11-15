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
from datetime import date

from fastapi import APIRouter, Depends, File, UploadFile
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

KINDS = ("pan", "selfie", "deed_first", "deed_last")
MAX_BYTES = 6 * 1024 * 1024
MIN_SIDE = {"selfie": 300, "pan": 700, "deed_first": 700, "deed_last": 700}
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
def upload_document(kind: str, file: UploadFile = File(...), scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
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
    db.exec("DELETE FROM owner_documents WHERE owner_account_id = :o AND kind = :k", o=scope.owner_account_id, k=kind)
    db.exec("""INSERT INTO owner_documents(owner_account_id, kind, mime, content_enc, sha256, uploaded_by, uploaded_phone)
               VALUES (:o, :k, :m, :c, :h, :u, :p)""",
            o=scope.owner_account_id, k=kind, m=mime, c=encrypt_bytes(data), h=hashlib.sha256(data).hexdigest(), u=scope.user.id,
            p=_phone(db, scope.user.id))
    db.audit(scope.user.id, scope.owner_account_id, "owner_document.uploaded", "owner_account", scope.owner_account_id, after={"kind": kind})
    return {"kind": kind, "uploaded": True}


class VerifyIn(BaseModel):
    legal_name: str = Field(max_length=100)
    address: str = Field(max_length=1000)           # the owner's own address
    declare: bool = False                            # "these are my own genuine documents and I am the person in the photos"


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
    limiter.check(f"docverify:{scope.user.id}", s.doc_max_tries_per_day, 86400)
    phone = _phone(db, scope.user.id)
    checks: list[dict] = []

    rows = {r["kind"]: r for r in db.all("SELECT kind, content_enc, sha256 FROM owner_documents WHERE owner_account_id = :o", o=scope.owner_account_id)}
    missing = [k for k in KINDS if k not in rows]
    if not _check(checks, "documents_missing", not missing, "Upload all four photos first: " + ", ".join(missing) if missing else "All four photos are uploaded."):
        return _finish(db, scope, "failed", checks, phone)

    eng = get_engine()
    img = {k: decrypt_bytes(rows[k]["content_enc"]) for k in KINDS}
    pan_text = eng.read_text(img["pan"])
    pan = docmatch.find_pan(pan_text)
    if _check(checks, "pan_readable", pan is not None, "The PAN number was read from the card." if pan else
              "The PAN number could not be read: photograph the whole card flat, in good light, without glare."):
        _check(checks, "name_matches_pan", docmatch.name_in_text(name, docmatch.pan_name_region(pan_text), s.doc_name_min),
               "The name you typed matches the PAN card." if docmatch.name_in_text(name, docmatch.pan_name_region(pan_text), s.doc_name_min)
               else "The name you typed was not found on the PAN card. Type it exactly as printed on the card.")
        born = docmatch.find_birth_date(pan_text)
        if born is not None:
            _check(checks, "adult", docmatch.age_on(born, date.today()) >= 18, "The owner must be at least 18 years old.")

    score, problem = eng.face_score(img["selfie"], img["pan"])
    if score is None:
        _check(checks, "face_found", False, "No face was found in your selfie: look straight at the camera in good light." if problem == "selfie"
               else "No face was found on the PAN card photo: photograph the whole card, close and sharp.")
    else:
        _check(checks, "face_match", score >= s.doc_face_min,
               "Your selfie matches the photo on the PAN card." if score >= s.doc_face_min
               else "Your selfie does not match the photo on the PAN card. Take it again facing the camera, in good light, without glasses or a cap.")

    deed_first, deed_last = eng.read_text(img["deed_first"]), eng.read_text(img["deed_last"])
    _check(checks, "deed_readable", docmatch.enough_text(deed_first) and docmatch.enough_text(deed_last, 8),
           "The deed pages were read." if docmatch.enough_text(deed_first) and docmatch.enough_text(deed_last, 8)
           else "The deed pages could not be read: photograph each page flat, whole and sharp.")
    deed = deed_first + "\n" + deed_last
    _check(checks, "name_matches_deed", docmatch.name_in_text(name, deed, s.doc_name_min),
           "Your name was found on the deed." if docmatch.name_in_text(name, deed, s.doc_name_min)
           else "Your name was not found on the deed pages. The first page must show you as owner.")

    # across all owners (row-level security hides other accounts, so this uses the system connection)
    hashes = [rows[k]["sha256"] for k in KINDS]
    with transaction() as sdb:
        photo_dup = bool(sdb.scalar("SELECT 1 FROM owner_documents WHERE owner_account_id <> :o AND sha256 IN (:a, :b, :c, :d) LIMIT 1",
                                    o=scope.owner_account_id, a=hashes[0], b=hashes[1], c=hashes[2], d=hashes[3]))
        pan_other_person = bool(pan and sdb.scalar("""SELECT 1 FROM owner_verifications v JOIN owner_accounts a ON a.id = v.owner_account_id
                                                      WHERE v.pan_hash = :p AND v.owner_account_id <> :o AND v.status IN ('submitted','verified')
                                                        AND a.primary_user_id <> :u LIMIT 1""",
                                                   p=_pan_hash(pan), o=scope.owner_account_id, u=scope.user.id))
        same_person_account = sdb.scalar("""SELECT v.owner_account_id FROM owner_verifications v JOIN owner_accounts a ON a.id = v.owner_account_id
                                            WHERE v.pan_hash = :p AND v.owner_account_id <> :o AND v.status IN ('submitted','verified')
                                              AND v.copied_from_account IS NULL AND a.primary_user_id = :u LIMIT 1""",
                                         p=_pan_hash(pan) if pan else "", o=scope.owner_account_id, u=scope.user.id)
    _check(checks, "photos_not_reused", not photo_dup, "These photos are not used on another account." if not photo_dup
           else "One of these photos is already used on another owner account.")
    if pan:
        _check(checks, "pan_not_reused", not pan_other_person, "This PAN is not registered to another owner." if not pan_other_person
               else "This PAN is already registered to another owner account.")

    ok = all(c["ok"] for c in checks)
    if ok:
        # keep the deed text (encrypted) so a property can be matched to the deed when it is added
        for k, t in (("deed_first", deed_first), ("deed_last", deed_last)):
            db.exec("UPDATE owner_documents SET text_enc = :t WHERE owner_account_id = :o AND kind = :k",
                    t=encrypt_bytes(t.encode(), "doctext"), o=scope.owner_account_id, k=k)
        _approve(user_id=scope.user.id, owner=scope.owner_account_id, name=name, address=address, pan=pan,
                 proof_ref="DOC-" + rows["deed_first"]["sha256"][:16].upper(), copied_from=same_person_account)
    return _finish(db, scope, "verified" if ok else "failed", checks, phone, pan=pan)


def _finish(db: Db, scope: OwnerScope, status: str, checks: list[dict], phone: str | None, pan: str | None = None) -> dict:
    db.audit(scope.user.id, scope.owner_account_id, f"owner_documents.{status}", "owner_account", scope.owner_account_id,
             after={"phone": phone, "pan": _mask_pan(pan) if pan else None, "failed": [c["code"] for c in checks if not c["ok"]]})
    return {"status": status, "checks": checks}


def _approve(*, user_id, owner, name: str, address: str, pan: str, proof_ref: str, copied_from) -> None:
    """Mark the owner's details and photo ID verified. The signed-in role cannot do this (database triggers), so it uses the system connection."""
    s = get_settings()
    with transaction() as sdb:
        sdb.exec("""INSERT INTO owner_verifications(owner_account_id, legal_name, pan_enc, pan_hash, pan_masked, address, proof_type, proof_ref,
                                                    declared_at, status, reviewed_at, review_note, copied_from_account)
                    VALUES (:o, :n, :pe, :ph, :pm, :a, 'sale_deed', :r, now(), 'verified', now(), :note, :cf)
                    ON CONFLICT (owner_account_id) DO UPDATE SET legal_name = :n, pan_enc = :pe, pan_hash = :ph, pan_masked = :pm, address = :a,
                      proof_type = 'sale_deed', proof_ref = :r, declared_at = now(), status = 'verified', reviewed_at = now(), review_note = :note,
                      copied_from_account = :cf, updated_at = now()""",
                 o=owner, n=name, pe=_enc_pan(pan), ph=_pan_hash(pan), pm=_mask_pan(pan), a=address, r=proof_ref, note=AUTO_NOTE, cf=copied_from)
        sdb.exec("UPDATE identity_verifications SET status = 'withdrawn', updated_at = now() WHERE user_id = :u AND status IN ('pending', 'manual_review')", u=user_id)
        if not sdb.scalar("SELECT 1 FROM identity_verifications WHERE user_id = :u AND status = 'verified' AND (expires_at IS NULL OR expires_at > now())", u=user_id):
            sdb.exec("UPDATE identity_verifications SET status = 'withdrawn', updated_at = now() WHERE user_id = :u AND status = 'verified'", u=user_id)   # expired
            sdb.exec("""INSERT INTO identity_verifications(user_id, status, provider, method, face_matched, name_matched, consent_version, expires_at,
                                                           reviewed_at, review_note)
                        VALUES (:u, 'verified', 'selfcheck', 'pan_selfie_ocr', true, true, 'doc-v1', now() + make_interval(days => :d), now(), :note)""",
                     u=user_id, d=s.kyc_validity_days, note=AUTO_NOTE)


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
