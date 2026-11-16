"""Renters: record a person (name, mobile, address, email and a photo ID) first, then allot them a place later.

The photo ID is kept encrypted and only the owner who recorded it can see it. An Aadhaar card has its first 8 digits blacked out automatically
before it is stored (the photo is refused if that fails). Allotting creates the tenancy and invitation exactly as before (the renter still
accepts in the app) and tells the renter by SMS, WhatsApp and email at the number and address the owner recorded."""
from __future__ import annotations

import hashlib
from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Header, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..core.auth import OwnerScope, owner_scope
from ..core.config import get_settings
from ..core.crypto import decrypt_bytes, encrypt_bytes
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..core.idempotency import fingerprint, idempotent
from ..domain import docmatch
from ..domain.validation import normalize_email, normalize_indian_mobile, validate_address, validate_full_name
from ..i18n.templates import render
from ..providers import docs as docs_provider
from ..providers.docs import BadImage
from ..providers.messaging import get_sender
from . import owner_docs, onboarding

router = APIRouter(prefix="/api/v1", tags=["renters"])

ID_TYPES = ("aadhaar", "pan", "voter", "driving", "passport")
MAX_BYTES = 6 * 1024 * 1024


def _row(r: dict) -> dict:
    return {"id": str(r["id"]), "name": r["name"], "phone": r["phone"], "email": r["email"], "address": r["address"], "id_type": r["id_type"],
            "allotted": r["tenancy_id"] is not None, "tenancy_id": str(r["tenancy_id"]) if r["tenancy_id"] else None,
            "created_at": r["created_at"]}


@router.post("/owner/renters")
def add_renter(name: str = Form(...), phone: str = Form(...), id_type: str = Form(...), keep_copy_ok: bool = Form(False),
               email: str | None = Form(None), address: str | None = Form(None), file: UploadFile = File(...),
               scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    owner, actor = scope.owner_account_id, scope.user.id
    limiter.check(f"renter-add:{owner}", 60, 3600)
    nm = validate_full_name(name, "name")
    ph = normalize_indian_mobile(phone, "phone")
    em = normalize_email(email, "email") if email and email.strip() else None
    addr = validate_address(address, required=False, field="address") if address and address.strip() else None
    if id_type not in ID_TYPES:
        raise AppError("VALIDATION", "choose the type of ID", fields=[{"field": "id_type", "code": "invalid"}])
    if not keep_copy_ok:
        raise AppError("VALIDATION", "tick that you may keep a copy of this ID", fields=[{"field": "keep_copy_ok", "code": "required"}])
    if db.scalar("SELECT 1 FROM renters WHERE owner_account_id = :o AND phone = :p", o=owner, p=ph):
        raise AppError("CONFLICT", "you have already added a renter with this mobile number", status=409)
    data = file.file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise AppError("VALIDATION", "the photo is too large (6 MB at most)", fields=[{"field": "file", "code": "too_large"}])
    try:
        mime, w, h = docs_provider.inspect_image(data)
    except BadImage as e:
        raise AppError("VALIDATION", f"{e}: take a JPEG or PNG photo", fields=[{"field": "file", "code": "invalid_image"}]) from e
    if min(w, h) < 400:
        raise AppError("VALIDATION", "the photo is too small: move closer or use the camera's normal quality", fields=[{"field": "file", "code": "too_small"}])
    stored = data
    if id_type == "aadhaar":
        # never keep a full Aadhaar number: black out its first 8 digits, and refuse the photo when that cannot be done
        text, masked = owner_docs.get_engine().read_aadhaar(data)
        if docmatch.find_aadhaar(text) is None:
            raise AppError("VALIDATION", "the Aadhaar number could not be read: photograph the card whole, flat and sharp",
                           fields=[{"field": "file", "code": "aadhaar_unreadable"}])
        if masked is None:
            raise AppError("VALIDATION", "the Aadhaar number could not be hidden automatically: try a sharper photo",
                           fields=[{"field": "file", "code": "aadhaar_not_masked"}])
        stored, mime = masked, "image/jpeg"
    rid = db.scalar("""INSERT INTO renters(owner_account_id, name, phone, email, address, id_type, id_mime, id_enc, id_sha256, keep_copy_ok, created_by)
                       VALUES (:o, :n, :p, :e, :a, :t, :m, :c, :h, true, :by) RETURNING id""",
                    o=owner, n=nm, p=ph, e=em, a=addr, t=id_type, m=mime, c=encrypt_bytes(stored), h=hashlib.sha256(data).hexdigest(), by=actor)
    db.audit(actor, owner, "renter.added", "renter", rid, after={"id_type": id_type})
    return {"id": str(rid), "name": nm, "phone": ph}


@router.get("/owner/renters")
def list_renters(allotted: bool | None = None, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    where = "" if allotted is None else (" AND tenancy_id IS NOT NULL" if allotted else " AND tenancy_id IS NULL")
    rows = db.all(f"SELECT * FROM renters WHERE owner_account_id = :o{where} ORDER BY created_at DESC", o=scope.owner_account_id)
    return {"items": [_row(r) for r in rows]}


@router.get("/owner/renters/{renter_id}/id-photo")
def renter_id_photo(renter_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> Response:
    r = db.must("SELECT id_mime, id_enc FROM renters WHERE id = :i AND owner_account_id = :o", "renter", i=renter_id, o=scope.owner_account_id)
    db.audit(scope.user.id, scope.owner_account_id, "renter.id_viewed", "renter", renter_id)
    return Response(decrypt_bytes(bytes(r["id_enc"])), media_type=r["id_mime"], headers={"Cache-Control": "no-store"})


@router.delete("/owner/renters/{renter_id}")
def remove_renter(renter_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Remove a renter who has not been given a place yet. Their details and ID photo are erased. A renter who has a rental is removed from
    the unit instead (End Tenancy), which keeps the rent history."""
    r = db.must("SELECT id, tenancy_id FROM renters WHERE id = :i AND owner_account_id = :o", "renter", i=renter_id, o=scope.owner_account_id)
    if r["tenancy_id"] is not None:
        raise AppError("CONFLICT", "this renter has a rental: remove them from the unit instead", status=409)
    db.exec("DELETE FROM renters WHERE id = :i", i=renter_id)
    db.audit(scope.user.id, scope.owner_account_id, "renter.removed", "renter", renter_id)
    return {"removed": True}


class AllotIn(BaseModel):
    unit_id: UUID
    monthly_rent: str | int
    due_day: int = 5
    start_date: date
    end_date: date
    security_deposit: str | int = "0"


def _tell_renter(renter: dict, owner_name: str, unit: str, sms_already: bool) -> dict:
    """SMS, WhatsApp and email to the renter. One channel failing never blocks the allotment: each result is reported."""
    body = render("invitation_install", "en", owner=owner_name, unit=unit)
    params = {"owner": owner_name, "unit": unit}
    s = get_settings()
    out: dict[str, str] = {}
    for channel, to in (("sms", renter["phone"]), ("whatsapp", renter["phone"]), ("email", renter["email"])):
        if channel == "sms" and sms_already:
            out[channel] = "sent"
            continue
        if not to:
            out[channel] = "skipped"
            continue
        try:
            res = get_sender(channel, s).send(to=to, template="invitation_install", language="en", params=params, body=body,
                                              subject=f"{owner_name} has allotted you {unit} on RentMeezy")
            out[channel] = "sent" if res.status == "sent" else "failed"
        except Exception:  # noqa: BLE001
            out[channel] = "failed"
    return out


@router.post("/owner/renters/{renter_id}/allot")
def allot_renter(renter_id: UUID, body: AllotIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db),
                 idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> dict:
    def work() -> dict:
        owner = scope.owner_account_id
        r = db.must("SELECT * FROM renters WHERE id = :i AND owner_account_id = :o", "renter", i=renter_id, o=owner)
        if r["tenancy_id"] is not None:
            raise AppError("CONFLICT", "this renter has already been allotted a place", status=409)
        tin = onboarding.TenancyIn(unit_id=body.unit_id, tenant_name=r["name"], tenant_mobile=r["phone"], tenant_email=r["email"],
                                   monthly_rent=body.monthly_rent, due_day=body.due_day, start_date=body.start_date, end_date=body.end_date,
                                   security_deposit=body.security_deposit)
        d = onboarding.validate_tenancy_input(tin)
        d["unit_identifier"] = ""
        res = onboarding.create_tenancy(db, scope, d)
        db.exec("UPDATE renters SET tenancy_id = :t WHERE id = :i", t=res["tenancy_id"], i=renter_id)
        unit = db.scalar("SELECT identifier FROM units WHERE id = :u", u=body.unit_id)
        owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=owner)
        res["notified"] = _tell_renter(r, owner_name, unit, bool(res.get("invite_sms_sent")))
        db.audit(scope.user.id, owner, "renter.allotted", "renter", renter_id, after={"tenancy_id": res["tenancy_id"], "notified": res["notified"]})
        return res
    return idempotent(db, scope.user.id, idempotency_key, fingerprint("POST", f"/owner/renters/{renter_id}/allot", {**body.model_dump(mode="json"), "r": str(renter_id)}), work)
