"""Properties: strongly validated, one registered owner each, one subscription each.

* A property is identified by its normalised address (+ pincode) and by its ownership proof reference. Neither can be registered by
  two owners: the database refuses it (unique indexes), and the app tells the second person, without revealing who the first is.
* Each property has its OWN subscription. An owner account holds one property; more properties are added as new accounts of the same
  person (same phone), each with its own plan and payment. A plan never lets one account hold a second property.
* A property is usable for billing renters only after a reviewer verifies it (the application role cannot verify by itself).
"""
from __future__ import annotations

import re
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owner_scope
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from . import owner_docs
from .action_otp import require_action_otp
from ..domain.validation import ValidationError, clean_text, validate_address, validate_pincode, validate_proof_ref

router = APIRouter(prefix="/api/v1", tags=["properties"])

ProofType = Literal["property_tax", "sale_deed", "electricity_bill", "lease_deed"]
PROOF_LABEL = {"property_tax": "Property tax receipt no.", "sale_deed": "Sale deed / registration no.",
               "electricity_bill": "Electricity service connection no.", "lease_deed": "Registered lease deed no."}
MAX_WORKSPACES = 25
MAX_EMPTY_WORKSPACES = 2

TAKEN_MESSAGE = ("This property is already registered on RentMeezy. If you co-own it, ask the registered owner to add your mobile number "
                 "under Owner numbers. If you believe this is a mistake, contact support with your ownership proof.")
PROOF_TAKEN_MESSAGE = "This ownership document number is already registered for another property. Check the number, or contact support."


class PropertyIn(BaseModel):
    address: str = Field(max_length=1000)
    name: str | None = Field(default=None, max_length=100)
    city: str = Field(max_length=80)
    state: str | None = Field(default=None, max_length=80)
    pincode: str
    kind: Literal["commercial", "residential", "mixed"] = "commercial"
    proof_type: ProofType | None = None      # left out when the owner passed the automatic document check: the property document
    proof_ref: str = Field(default="", max_length=40)      # named in the owner details is used, so the owner is not asked twice
    declare: bool = False            # "I own this property or am legally authorised to rent it out"
    otp_code: str | None = None      # the code sent to the account's own mobile (needed to submit, not to check)


def validate_property(body: PropertyIn) -> dict:
    """Format checks only (no database): everything is cleaned, required and sanity-checked before it is stored."""
    address = validate_address(body.address, required=True, field="property_address")
    pincode = validate_pincode(body.pincode)
    if pincode is None:
        raise ValidationError("pincode", "required")
    city = clean_text(body.city or "")
    if len(city) < 2:
        raise ValidationError("city", "required")
    if not body.declare:
        raise ValidationError("declare", "required")
    if body.proof_type is None:
        raise ValidationError("proof_type", "required")
    ref = validate_proof_ref(body.proof_ref)         # (rejects placeholders such as 000000, AAAAAA, 123456, TEST, NA ...)
    return {"address": address, "name": (clean_text(body.name) if body.name else None), "city": city,
            "state": clean_text(body.state) if body.state else None, "pincode": pincode, "kind": body.kind,
            "proof_type": body.proof_type, "proof_ref": ref}


def check_conflict(db: Db, v: dict) -> None:
    """Across ALL owners, without revealing who: is this address or ownership proof already registered?"""
    hit = db.scalar("SELECT rg_property_conflict(:a, :p, :t, :r)", a=v["address"], p=v["pincode"], t=v["proof_type"], r=v["proof_ref"])
    if hit == "address":
        raise AppError("PROPERTY_ALREADY_REGISTERED", TAKEN_MESSAGE)
    if hit == "proof":
        raise AppError("PROPERTY_PROOF_ALREADY_USED", PROOF_TAKEN_MESSAGE)


def _require_owner_details(db: Db, owner: UUID) -> None:
    st = db.scalar("SELECT status FROM owner_verifications WHERE owner_account_id = :o", o=owner)
    if st is None or st == "rejected":
        raise AppError("OWNER_DETAILS_REQUIRED", "complete your owner details before adding a property")


def _require_photo_id(db: Db, owner: UUID) -> None:
    """The person who owns the account must have a verified photo ID (government ID + live selfie + name match) before a property is accepted."""
    from .kyc import identity_verified
    primary = db.scalar("SELECT primary_user_id FROM owner_accounts WHERE id = :o", o=owner)
    if primary is None or not identity_verified(db, primary):
        raise AppError("IDENTITY_REQUIRED", "verify your photo ID before adding a property")


def mask_ref(ref: str | None) -> str | None:
    return None if not ref else ("•" * max(len(ref) - 4, 2)) + ref[-4:]


@router.post("/owner/properties/check")
def check_property(body: PropertyIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Validate a property BEFORE paying for it: format, and whether it is already registered. Stores nothing.
    Limited per person, so it cannot be used to probe which addresses exist."""
    limiter.check(f"propcheck:{scope.user.id}", 10, 3600)
    _require_owner_details(db, scope.owner_account_id)
    _require_photo_id(db, scope.owner_account_id)
    owner_docs.use_owner_details_proof(db, scope.owner_account_id, body)      # no-op unless the automatic document check is on
    v = validate_property(body)
    check_conflict(db, v)
    owner_docs.check_property_against_deed(db, scope.owner_account_id, v)      # no-op unless the automatic document check is on
    return {"ok": True}


@router.post("/owner/properties")
def create_property(body: PropertyIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Register THE property of this account (needs a paid plan). Goes to review; renters can be added once it is verified."""
    limiter.check(f"propadd:{scope.user.id}", 10, 3600)
    _require_owner_details(db, scope.owner_account_id)
    _require_photo_id(db, scope.owner_account_id)
    db.scalar("SELECT rg_require_owner_writable(:o)", o=scope.owner_account_id)
    auto = owner_docs.use_owner_details_proof(db, scope.owner_account_id, body)      # the owner already named and signed the property document
    v = validate_property(body)
    check_conflict(db, v)
    owner_docs.check_property_against_deed(db, scope.owner_account_id, v)
    if not auto:                                                              # (the signature page replaced the text-message code)
        require_action_otp(db, scope.user.id, "property", body.otp_code)      # last, so a wrong form never burns a code
    pid = db.scalar("""INSERT INTO properties(owner_account_id, name, address, city, state, pincode, kind, proof_type, proof_ref, declared_at)
                       VALUES (:o, :n, :a, :c, :s, :pc, :k, :pt, :pr, now()) RETURNING id""",
                    o=scope.owner_account_id, n=v["name"], a=v["address"], c=v["city"], s=v["state"], pc=v["pincode"], k=v["kind"],
                    pt=v["proof_type"], pr=v["proof_ref"])
    db.audit(scope.user.id, scope.owner_account_id, "property.submitted", "property", pid, after={"proof_type": v["proof_type"]})
    db.scalar("SELECT rg_demo_verify_property(:p)", p=pid)         # no-op unless the local-demo flag is on
    db.scalar("SELECT rg_doc_verify_property(:p)", p=pid)          # no-op unless the automatic document check is on and this owner passed it
    return _property_view(db, pid)


def _property_view(db: Db, pid: UUID) -> dict:
    r = db.must("SELECT * FROM properties WHERE id = :p", "property", p=pid)
    return {"id": str(r["id"]), "name": r["name"], "address": r["address"], "city": r["city"], "state": r["state"], "pincode": r["pincode"],
            "kind": r["kind"], "verification_status": r["verification_status"], "proof_type": r["proof_type"],
            "proof_ref": mask_ref(r["proof_ref"]), "review_note": r["review_note"]}


@router.get("/owner/properties")
def list_properties(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    rows = db.all("""SELECT p.id FROM properties p WHERE p.owner_account_id = :o AND p.archived_at IS NULL ORDER BY p.created_at""", o=scope.owner_account_id)
    items = []
    for r in rows:
        d = _property_view(db, r["id"])
        d.update(db.one("""SELECT count(*) FILTER (WHERE u.status = 'active') AS active_units,
                                  count(*) FILTER (WHERE u.status = 'active' AND NOT EXISTS (
                                      SELECT 1 FROM tenancies t WHERE t.unit_id = u.id AND t.status IN ('invited', 'active'))) AS vacant_units
                           FROM units u WHERE u.property_id = :p""", p=r["id"]))
        items.append(d)
    return {"items": items}


@router.post("/owner/properties/{property_id}/remove")
def remove_property(property_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Take a property off the list. Only when nobody lives in it (and no invitation is waiting): the renters have to be removed first, so a
    rental, its rent history and its deposit are never cut off by accident. Its units are archived; nothing is erased, and the address can be added again."""
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the main owner can remove a property")
    owner = scope.owner_account_id
    prop = db.must("SELECT id, name, address FROM properties WHERE id = :p AND owner_account_id = :o AND archived_at IS NULL", "property", p=property_id, o=owner)
    live = db.all("""SELECT u.identifier FROM units u JOIN tenancies t ON t.unit_id = u.id AND t.status IN ('invited', 'active')
                     WHERE u.property_id = :p ORDER BY u.identifier""", p=property_id)
    if live:
        names = ", ".join(r["identifier"] for r in live[:5]) + (" and more" if len(live) > 5 else "")
        raise AppError("CONFLICT", f"renters still live here ({names}). Remove them first, then remove the property.", status=409,
                       units=[r["identifier"] for r in live])
    db.exec("UPDATE units SET status = 'archived' WHERE property_id = :p AND status = 'active'", p=property_id)
    db.exec("UPDATE properties SET archived_at = now() WHERE id = :p", p=property_id)
    db.audit(scope.user.id, owner, "property.removed", "property", property_id, after={"address": prop["address"]})
    return {"removed": True}


@router.post("/owner/workspaces")
def add_property_account(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Start ANOTHER property: a new owner account for the same person (same phone) that needs its own plan and payment.
    The reviewed owner details are copied, so they are not asked again. The next steps are: choose a plan, pay, add the property."""
    user: CurrentUser = scope.user
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the main owner of an account can add another property")
    limiter.check(f"workspace:{user.id}", 5, 3600)
    _require_owner_details(db, scope.owner_account_id)
    mine = db.all("""SELECT o.id, (SELECT count(*) FROM properties p WHERE p.owner_account_id = o.id AND p.archived_at IS NULL) AS props
                     FROM owner_accounts o WHERE o.primary_user_id = :u""", u=user.id)
    if len(mine) >= MAX_WORKSPACES:
        raise AppError("CONFLICT", "too many properties on this number; contact support")
    if sum(1 for m in mine if m["props"] == 0) >= MAX_EMPTY_WORKSPACES:
        raise AppError("CONFLICT", "finish the property you already started (choose a plan and add it) before starting another")
    cur_props = db.scalar("SELECT count(*) FROM properties WHERE owner_account_id = :o AND archived_at IS NULL", o=scope.owner_account_id)
    if cur_props == 0:
        raise AppError("CONFLICT", "add the property to your current account first; a new account is only for a second property")
    name = db.scalar("SELECT COALESCE(full_name, 'Owner') FROM users WHERE id = :u", u=user.id)
    oid = db.scalar("INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (:u, :n) RETURNING id", u=user.id, n=name)
    db.exec("INSERT INTO owner_memberships(owner_account_id, user_id, role) VALUES (:o, :u, 'owner')", o=oid, u=user.id)
    db.exec("INSERT INTO reminder_rules(owner_account_id) VALUES (:o) ON CONFLICT DO NOTHING", o=oid)
    db.exec("""INSERT INTO owner_verifications(owner_account_id, legal_name, address, proof_type, proof_ref, declared_at, status, reviewed_at,
                                                review_note, pan_enc, pan_hash, pan_masked, copied_from_account)
               SELECT :n, legal_name, address, proof_type, proof_ref, declared_at, status, reviewed_at, review_note,
                      pan_enc, pan_hash, pan_masked, :src FROM owner_verifications WHERE owner_account_id = :src""", n=oid, src=scope.owner_account_id)
    db.audit(user.id, oid, "owner_account.added_for_property", "owner_account", oid)
    return {"owner_account_id": str(oid), "next": "choose_plan"}


@router.get("/owner/workspaces")
def my_properties(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    """Every property (account) this person owns or co-owns, with plan, units and vacancy: the 'My properties' list."""
    rows = db.all("""SELECT m.owner_account_id AS id, m.role, rg_owner_write_state(m.owner_account_id) AS state
                     FROM owner_memberships m WHERE m.user_id = :u AND m.status = 'active' ORDER BY m.created_at""", u=user.id)
    items = []
    for r in rows:
        prop = db.one("SELECT id FROM properties WHERE owner_account_id = :o AND archived_at IS NULL ORDER BY created_at LIMIT 1", o=r["id"])
        sub = db.one("SELECT plan_code, max_units, period_end FROM owner_subscriptions WHERE owner_account_id = :o AND status IN ('active','grace')", o=r["id"])
        d = {"owner_account_id": str(r["id"]), "role": r["role"], "state": r["state"],
             "plan": sub["plan_code"] if sub else None, "units_capacity": sub["max_units"] if sub else 0,
             "period_end": sub["period_end"].isoformat() if sub else None, "property": None, "active_units": 0, "vacant_units": 0}
        if prop:
            d["property"] = _property_view(db, prop["id"])
            c = db.one("""SELECT count(*) FILTER (WHERE u.status = 'active') AS a,
                                 count(*) FILTER (WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM tenancies t WHERE t.unit_id = u.id AND t.status IN ('invited','active'))) AS v
                          FROM units u WHERE u.property_id = :p""", p=prop["id"])
            d["active_units"], d["vacant_units"] = c["a"], c["v"]
        items.append(d)
    return {"items": items}
