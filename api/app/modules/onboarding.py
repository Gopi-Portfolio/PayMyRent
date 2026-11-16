"""Properties, units, tenancy onboarding (manual + Excel through ONE service), invitations,
owner-specific tenant contact edits, contact-change proposals and tenancy closure."""
from __future__ import annotations

import json
import secrets
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain import excel_import
from ..domain.money import format_inr, parse_inr
from ..domain.places import floor_name, normalize_kind
from ..domain.validation import (
    clean_text, validate_items, normalize_email, normalize_indian_mobile, validate_address, validate_date_range, validate_due_day,
    validate_full_name, validate_note, validate_pincode, validate_unit_identifier, ValidationError,
)
from . import notify

router = APIRouter(prefix="/api/v1", tags=["onboarding"])
# "residential" and "commercial" are the two kinds; the older names are still accepted and mapped (house / flat -> residential, shop / office / other -> commercial)
UnitKind = Literal["residential", "commercial", "house", "flat", "shop", "office", "other"]


# ───────────────────────── owner details (required before onboarding tenants) ─────────────────────────
ProofType = Literal["property_tax", "electricity_bill", "sale_deed", "rent_agreement", "gst", "other"]


class OwnerDetailsIn(BaseModel):
    legal_name: str = Field(max_length=400)
    pan: str = Field(max_length=10)
    address: str = Field(max_length=1000)
    proof_type: ProofType
    proof_ref: str = Field(max_length=80)
    declare: bool
    otp_code: str | None = None          # the code sent to the account's own mobile


from ..core.crypto import encrypt as _enc_pan, lookup_hash as _pan_hash, mask_pan as _mask_pan


@router.get("/owner/verification")
def get_owner_details(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    r = db.one("SELECT * FROM owner_verifications WHERE owner_account_id = :o", o=scope.owner_account_id)
    if r is None:
        return {"status": "none"}
    return {"status": r["status"], "legal_name": r["legal_name"], "pan_masked": r["pan_masked"], "address": r["address"],
            "proof_type": r["proof_type"], "proof_ref": r["proof_ref"], "review_note": r["review_note"]}


@router.put("/owner/verification")
def submit_owner_details(body: OwnerDetailsIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    import re
    from .action_otp import require_action_otp
    if not body.declare:
        raise AppError("VALIDATION", "you must confirm the declaration", fields=[{"field": "declare", "code": "required"}])
    pan = body.pan.strip().upper()
    if not re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", pan):
        raise AppError("VALIDATION", "PAN must look like ABCDE1234F", fields=[{"field": "pan", "code": "pan_invalid"}])
    name = validate_full_name(body.legal_name, "legal_name")
    address = validate_address(body.address, required=True, field="address")
    ref = body.proof_ref.strip()
    if not 3 <= len(ref) <= 80:
        raise AppError("VALIDATION", "enter the document number", fields=[{"field": "proof_ref", "code": "required"}])
    if db.scalar("""SELECT 1 FROM owner_verifications v JOIN owner_accounts a ON a.id = v.owner_account_id
                    WHERE v.pan_hash = :p AND v.owner_account_id <> :o AND v.status IN ('submitted','verified')
                      AND a.primary_user_id <> :u""",            # the same person's other accounts do not count
                 p=_pan_hash(pan), o=scope.owner_account_id, u=scope.user.id):
        raise AppError("CONFLICT", "this PAN is already registered to another owner account", fields=[{"field": "pan", "code": "pan_in_use"}])
    require_action_otp(db, scope.user.id, "owner_details", body.otp_code)      # last, so a wrong form never burns a code
    db.exec("""INSERT INTO owner_verifications(owner_account_id, legal_name, pan_enc, pan_hash, pan_masked, address, proof_type, proof_ref)
               VALUES (:o, :n, :pe, :ph, :pm, :a, :t, :r)
               ON CONFLICT (owner_account_id) DO UPDATE SET legal_name = :n, pan_enc = :pe, pan_hash = :ph, pan_masked = :pm, address = :a, proof_type = :t, proof_ref = :r,
                 declared_at = now(), updated_at = now(), status = 'submitted', reviewed_at = NULL, review_note = NULL""",
            o=scope.owner_account_id, n=name, pe=_enc_pan(pan), ph=_pan_hash(pan), pm=_mask_pan(pan), a=address, t=body.proof_type, r=ref)
    db.audit(scope.user.id, scope.owner_account_id, "owner.details_submitted", "owner_account", scope.owner_account_id,
             after={"pan": _mask_pan(pan), "proof_type": body.proof_type})
    return {"status": "submitted"}


# ───────────────────────── properties & units ─────────────────────────
class PropertyRef(BaseModel):
    """Points at the account's EXISTING property by address (a property can only be created, with proof, through /owner/properties)."""
    address: str = Field(max_length=1000)
    name: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=80)
    state: str | None = Field(default=None, max_length=80)
    pincode: str | None = None
    kind: str | None = None


def _resolve_property(db: Db, owner: UUID, ref: dict | None, property_id: UUID | None) -> UUID:
    """The property a renter is being added to. It must already exist in THIS account (created with proof, and verified)."""
    if property_id:
        db.must("SELECT 1 FROM properties WHERE id = :p AND owner_account_id = :o AND archived_at IS NULL", "property", p=property_id, o=owner)
        return property_id
    props = db.all("SELECT id, address, pincode FROM properties WHERE owner_account_id = :o AND archived_at IS NULL ORDER BY created_at", o=owner)
    if not props:
        raise AppError("PROPERTY_NOT_VERIFIED", "register your property (with ownership proof) before adding renters")
    if ref and ref.get("address"):
        key = db.scalar("SELECT rg_address_key(:a, :p)", a=validate_address(ref["address"], required=True, field="property_address"),
                        p=validate_pincode(ref.get("pincode")) or next((p["pincode"] for p in props if p["pincode"]), None))
        for p in props:
            if db.scalar("SELECT rg_address_key(:a, :p)", a=p["address"], p=p["pincode"]) == key:
                return p["id"]
        if len(props) == 1:      # one property per account: a differently typed address is still this property
            return props[0]["id"]
        raise AppError("VALIDATION", "this address is not one of your registered properties")
    if len(props) == 1:
        return props[0]["id"]
    raise AppError("VALIDATION", "choose the property")


class UnitIn(BaseModel):
    property_id: UUID
    identifier: str = Field(max_length=90)
    kind: UnitKind = "commercial"
    floor: int | None = Field(default=None, ge=0, le=10)     # 0 = ground, 1 = 1st ... 10 = 10th


def search_terms(q: str | None) -> dict:
    """Turn what the owner typed into safe LIKE patterns.
    * leading/trailing/extra spaces are ignored; % and _ are literal characters, not wildcards;
    * a number search of 5+ digits (spaces, dashes and +91 allowed) matches phone numbers;
    * a short number (1-4 digits) matches only the shop/house number, so "1" does not match every phone."""
    text = " ".join((q or "").split())
    if not text:
        return {"idt": None, "nm": None, "ph": None}
    esc = lambda v: v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    numeric = all(c.isdigit() or c in " +-" for c in text)
    digits = "".join(c for c in text if c.isdigit())
    if numeric and len(digits) >= 5:
        return {"idt": f"%{esc(digits)}%", "nm": None, "ph": f"%{digits}%"}
    pattern = f"%{esc(text)}%"
    return {"idt": pattern, "nm": None if numeric else pattern, "ph": None}


OWING = "b.balance_paise > 0"
OVERDUE = "EXISTS (SELECT 1 FROM v_invoice_status vi WHERE vi.tenancy_id = t.id AND vi.open_paise > 0 AND vi.due_date < CURRENT_DATE)"
PAID = "b.balance_paise <= 0"
STATUS_WORDS: dict[str, str] = {
    **{w: OWING for w in ("unpaid", "pending", "due", "dues", "owing", "owes", "balance", "outstanding", "unsettled")},
    "overdue": OVERDUE, "late": OVERDUE,
    **{w: PAID for w in ("paid", "cleared", "settled", "clear")},
    **{w: "u.kind = 'residential'" for w in ("house", "houses", "home", "homes", "flat", "flats", "residential", "apartment", "apartments", "room", "rooms")},
    **{w: "u.kind = 'commercial'" for w in ("shop", "shops", "store", "stores", "office", "offices", "commercial", "commercials", "factory", "building", "warehouse", "godown", "complex")},
    "invited": "t.status = 'invited'", "active": "t.status = 'active'", "live": "t.status = 'active'",
}
NOISE_WORDS = {"up", "only", "the", "and", "of", "all", "to", "pay", "payment"}
MIN_PREFIX = 3          # 3 letters are enough: "unp" finds unpaid, "pen" finds pending, "ove" finds overdue


def tenancy_search(q: str | None) -> tuple[str, dict]:
    """Free search over a tenancy list. Every word must match (AND), in any order, and a word can be a STATUS as well as text:
    pending / unpaid / due / balance -> something is owed; overdue -> past its due date; paid / cleared -> nothing owed;
    shop(s) / house(s) -> the kind of unit; invited / active -> the renter's status. The first 3 letters of a status word are enough
    (a partial word also still matches names and addresses). Anything else is matched inside the unit number, renter name, property
    name, address and city; a number of 4+ digits also matches the phone, the rent and the balance (in rupees). % and _ are literal."""
    words = [w for w in " ".join((q or "").lower().replace(",", " ").split()).split(" ") if w]
    conds, params = [], {}
    esc = lambda v: v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    for i, w in enumerate(words):
        if w in NOISE_WORDS and len(words) > 1:
            continue
        if w in STATUS_WORDS:                                    # a whole status word
            conds.append(STATUS_WORDS[w])
            continue
        digits = "".join(c for c in w if c.isdigit())
        alts: list[str] = []
        if len(w) >= MIN_PREFIX and w.isalpha():                  # the start of a status word, e.g. "unp" -> unpaid
            alts += sorted({c for k, c in STATUS_WORDS.items() if k.startswith(w)})
        if w.lstrip("+").replace("-", "").isdigit() and len(digits) >= 4:
            # a number of 4+ digits: part of the phone (e.g. its last 4 digits), the unit number, or the rent / balance in rupees
            params[f"w{i}"] = f"%{digits}%"
            alts.append(f"(s.phone LIKE CAST(:w{i} AS text) OR u.identifier ILIKE CAST(:w{i} AS text) "
                        f"OR CAST(t.monthly_rent_paise / 100 AS text) LIKE CAST(:w{i} AS text) "
                        f"OR CAST(b.balance_paise / 100 AS text) LIKE CAST(:w{i} AS text))")
        else:
            params[f"w{i}"] = f"%{esc(w)}%"
            text = f"u.identifier ILIKE CAST(:w{i} AS text) ESCAPE '\\'"
            if not w.isdigit():
                p = f"CAST(:w{i} AS text)"
                text += (f" OR s.name ILIKE {p} ESCAPE '\\' OR p.name ILIKE {p} ESCAPE '\\' OR p.address ILIKE {p} ESCAPE '\\'"
                         f" OR p.city ILIKE {p} ESCAPE '\\'")
            alts.append(f"({text})")
        conds.append("(" + " OR ".join(alts) + ")" if len(alts) > 1 else alts[0])
    return (" AND ".join(conds) if conds else "TRUE"), params


@router.get("/owner/units")
def list_units(q: str | None = Query(default=None, max_length=50), status: Literal["active", "archived", "all"] = "active",
               vacant: bool | None = None, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Units with their state. `vacant` = active, with no renter or open invitation (e.g. after the renter's period ended and they left):
    these are the units an owner can fill by tapping 'Add renter'."""
    rows = db.all("""SELECT u.id, u.identifier, u.kind, u.floor, u.status, p.id AS property_id, p.name AS property_name, p.address,
                            t.id AS tenancy_id, t.status AS tenancy_status, s.name AS tenant_name,
                            (u.status = 'active' AND t.id IS NULL) AS vacant,
                            CASE WHEN u.status = 'active' AND t.id IS NULL
                                 THEN (SELECT max(e.end_date) FROM tenancies e WHERE e.unit_id = u.id AND e.status = 'ended') END AS vacant_since,
                            (SELECT e.monthly_rent_paise FROM tenancies e WHERE e.unit_id = u.id AND e.status = 'ended' ORDER BY e.end_date DESC NULLS LAST LIMIT 1) AS last_rent_paise
                     FROM units u JOIN properties p ON p.id = u.property_id
                     LEFT JOIN tenancies t ON t.unit_id = u.id AND t.status IN ('invited','active')
                     LEFT JOIN LATERAL (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) s ON true
                     WHERE u.owner_account_id = :o AND (:st = 'all' OR u.status = :st)
                       AND (CAST(:vac AS boolean) IS NULL OR (u.status = 'active' AND t.id IS NULL) = CAST(:vac AS boolean))
                       AND (CAST(:idt AS text) IS NULL OR u.identifier ILIKE CAST(:idt AS text) ESCAPE '\\' OR s.name ILIKE CAST(:nm AS text) ESCAPE '\\'
                            OR p.name ILIKE CAST(:nm AS text) ESCAPE '\\' OR p.address ILIKE CAST(:nm AS text) ESCAPE '\\')
                     ORDER BY p.created_at, u.identifier LIMIT 300""", o=scope.owner_account_id, st=status, vac=vacant, **search_terms(q))
    return {"items": [dict(r) for r in rows]}


@router.post("/owner/units")
def create_unit(body: UnitIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    db.must("SELECT 1 FROM properties WHERE id = :p AND owner_account_id = :o", "property", p=body.property_id, o=scope.owner_account_id)
    ident = validate_unit_identifier(body.identifier)
    body_kind = normalize_kind(body.kind)
    same = db.scalar(f"""SELECT identifier FROM units WHERE property_id = :p AND {_UNIT_KEY} = regexp_replace(lower(:i), '[^a-z0-9]', '', 'g')
                         AND COALESCE(floor, -1) = COALESCE(:f, -1)""", p=body.property_id, i=ident, f=body.floor)
    if same:
        where = f" on the {floor_name(body.floor).lower()}" if body.floor is not None else ""
        raise AppError("CONFLICT", f"{same}{where} already exists in this building. The same number can be used on another floor, but not twice on one floor.", status=409)
    uid = db.scalar("""INSERT INTO units(owner_account_id, property_id, identifier, kind, floor) VALUES (:o, :p, :i, :k, :f) RETURNING id""",
                    o=scope.owner_account_id, p=body.property_id, i=ident, k=body_kind, f=body.floor)
    db.audit(scope.user.id, scope.owner_account_id, "unit.created", "unit", uid)
    return dict(db.one("SELECT * FROM units WHERE id = :u", u=uid))


@router.post("/owner/units/{unit_id}/{action}")
def unit_status(unit_id: UUID, action: Literal["archive", "reactivate"], scope: OwnerScope = Depends(owner_scope),
                db: Db = Depends(get_db)) -> dict:
    # Capacity on reactivation is re-checked by the database trigger.
    n = db.exec("UPDATE units SET status = :s WHERE id = :u AND owner_account_id = :o",
                s="archived" if action == "archive" else "active", u=unit_id, o=scope.owner_account_id)
    if not n:
        raise AppError("NOT_FOUND", "unit not found")
    db.audit(scope.user.id, scope.owner_account_id, f"unit.{action}", "unit", unit_id)
    return dict(db.one("SELECT * FROM units WHERE id = :u", u=unit_id))


# ───────────────────────── tenancy onboarding (shared by manual + import) ─────────────────────────
class TenancyIn(BaseModel):
    # step 1
    property_id: UUID | None = None
    property: PropertyRef | None = None
    unit_id: UUID | None = None                    # a vacant unit picked from the list (then no unit number is typed)
    unit_identifier: str = Field(default="", max_length=90)
    unit_kind: UnitKind = "commercial"
    unit_floor: int | None = Field(default=None, ge=0, le=10)           # floor of a NEW unit: 0 = ground, 1 = 1st ... 10 = 10th
    items_provided: str | None = Field(default=None, max_length=2500)     # what the owner provides with the place: commas or new lines
    increment_percent: float | None = Field(default=None, ge=0, le=100)   # yearly rent increase applied when the agreement is renewed
    # step 2
    tenant_name: str = Field(max_length=400)
    tenant_mobile: str = Field(max_length=20)
    monthly_rent: str | int
    due_day: int
    start_date: date
    security_deposit: str | int = "0"
    deposit_already_received: bool = True
    # optional (collapsed in the UI)
    tenant_email: str | None = None
    tenant_alt_mobile: str | None = None
    end_date: date | None = None
    opening_arrears: str | int | None = None
    notes: str | None = None
    grace_days: int = Field(default=0, ge=0, le=60)
    # how the owner wants to receive rent from THIS tenant: 'upi' (direct, free), 'online' (app checkout) or 'cash'. The app always asks.
    pay_method: Literal["upi", "online", "cash"] | None = None
    pay_upi_id: str | None = Field(default=None, max_length=80)
    otp_code: str | None = None                    # needed when the UPI ID is new to this owner


def require_owner_details(db: Db, owner: UUID) -> None:
    """Owners must submit their details (legal name, PAN, address, property document reference) before
    adding properties or tenants. A rejected submission blocks again until corrected."""
    st = db.scalar("SELECT status FROM owner_verifications WHERE owner_account_id = :o", o=owner)
    if st is None or st == "rejected":
        raise AppError("OWNER_DETAILS_REQUIRED", "complete your owner details before adding properties or tenants")


_UNIT_KEY = "regexp_replace(lower(identifier), '[^a-z0-9]', '', 'g')"      # same flat however it is spelled


def create_tenancy(db: Db, scope: OwnerScope, d: dict, source: str = "owner") -> dict:
    """Validated data in (see TenancyIn / excel_import row.data), tenancy + invitation out."""
    owner, actor = scope.owner_account_id, scope.user.id
    require_owner_details(db, owner)
    db.scalar("SELECT rg_require_owner_writable(:o)", o=owner)
    if d.get("unit_id"):
        unit = db.must("""SELECT u.id, u.status, u.identifier, u.property_id FROM units u WHERE u.id = :u AND u.owner_account_id = :o""", "unit", u=d["unit_id"], o=owner)
        unit_id, d["unit_identifier"] = unit["id"], unit["identifier"]
        if unit["status"] == "archived":
            db.exec("UPDATE units SET status = 'active' WHERE id = :u", u=unit_id)      # capacity re-checked by trigger
    else:
        pid = _resolve_property(db, owner, d.get("property"), d.get("property_id"))
        same_number = db.all(f"SELECT id, status, identifier, floor FROM units WHERE property_id = :p AND {_UNIT_KEY} = regexp_replace(lower(:i), '[^a-z0-9]', '', 'g')",
                             p=pid, i=d["unit_identifier"])
        floor = d.get("unit_floor")
        # a place is building + floor + number: the same number on another floor is a different place
        unit = next((u for u in same_number if u["floor"] == floor), None)
        if unit is None and floor is None and len(same_number) == 1:
            unit = same_number[0]                                         # no floor given and only one place has this number: that one
        if unit is None and floor is None and len(same_number) > 1:
            raise AppError("VALIDATION", f"{d['unit_identifier']} exists on more than one floor. Choose the floor.", fields=[{"field": "unit_floor", "code": "floor_required"}])
        if unit is not None:
            d["unit_identifier"] = unit["identifier"]                     # "s 01" means the existing unit "S-01"
            d["unit_floor"] = unit["floor"]
        if unit is None:
            unit_id = db.scalar("INSERT INTO units(owner_account_id, property_id, identifier, kind, floor) VALUES (:o, :p, :i, :k, :f) RETURNING id",
                                o=owner, p=pid, i=d["unit_identifier"], k=normalize_kind(d.get("unit_kind")), f=d.get("unit_floor"))
        else:
            unit_id = unit["id"]
            if unit["status"] == "archived":
                db.exec("UPDATE units SET status = 'active' WHERE id = :u", u=unit_id)  # capacity re-checked by the database trigger
    live = db.one("""SELECT t.status, (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) AS tenant
                     FROM tenancies t WHERE t.unit_id = :u AND t.status IN ('invited','active') LIMIT 1""", u=unit_id)
    if live is not None:      # one address, one tenant: the first must be removed or vacated before anyone else is added
        who = live["tenant"] or "a tenant"
        at = f" ({floor_name(d.get('unit_floor'))})" if d.get("unit_floor") is not None else ""
        raise AppError("UNIT_OCCUPIED", f"{d['unit_identifier']}{at} is already {'let to' if live['status'] == 'active' else 'offered to'} {who}. "
                       "End that rental (vacate) or remove the invitation before adding another tenant to the same address.", status=409)
    owner_phones = {r["value"] for r in db.all("""SELECT c.value FROM user_contacts c JOIN owner_memberships m ON m.user_id = c.user_id
                                                  WHERE m.owner_account_id = :o AND c.kind = 'mobile' AND c.removed_at IS NULL
                                                  UNION SELECT phone FROM owner_allowed_numbers WHERE owner_account_id = :o AND removed_at IS NULL""", o=owner)}
    if d["tenant_mobile"] in owner_phones:
        raise AppError("VALIDATION", "the tenant's number cannot be the owner's own number")
    pay_method, pay_upi = (None, None)
    if d.get("pay_method"):
        from .payments import resolve_pay_method
        pay_method, pay_upi = resolve_pay_method(db, scope, d["pay_method"], d.get("pay_upi_id"), d.get("otp_code"))
        if pay_upi is None and pay_method == db.scalar("SELECT default_pay_method FROM owner_accounts WHERE id = :o", o=owner):
            pay_method = None                                  # the same as the owner's usual way: this tenant follows it
    tid = db.scalar("""INSERT INTO tenancies(owner_account_id, unit_id, invited_phone, start_date, end_date, monthly_rent_paise,
                                             due_day, grace_days, deposit_agreed_paise, items_provided, increment_percent, pay_method, pay_upi_id)
                       VALUES (:o, :u, :ph, :sd, :ed, :r, :dd, :g, :dep, :items, :inc, :pm, :pu) RETURNING id""",
                    o=owner, u=unit_id, ph=d["tenant_mobile"], sd=d["start_date"], ed=d.get("end_date"), r=d["monthly_rent_paise"],
                    dd=d["due_day"], g=d.get("grace_days", 0), dep=d["deposit_paise"], items=d.get("items_provided"), inc=d.get("increment_percent"),
                    pm=pay_method, pu=pay_upi)
    db.exec("""INSERT INTO tenancy_agreements(owner_account_id, tenancy_id, seq, kind, start_date, end_date, monthly_rent_paise, created_by)
               VALUES (:o, :t, 1, 'original', :sd, :ed, :r, :by)""", o=owner, t=tid, sd=d["start_date"], ed=d.get("end_date"), r=d["monthly_rent_paise"], by=actor)
    db.exec("""INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, alt_phone, email, created_by)
               VALUES (:t, :n, :p, :a, :e, :by)""", t=tid, n=d["tenant_name"], p=d["tenant_mobile"],
            a=d.get("tenant_alt_mobile"), e=d.get("tenant_email"), by=actor)
    inv = db.scalar("INSERT INTO tenancy_invitations(tenancy_id, phone) VALUES (:t, :p) RETURNING id", t=tid, p=d["tenant_mobile"])
    db.exec("INSERT INTO deposits(tenancy_id, agreed_paise) VALUES (:t, :a)", t=tid, a=d["deposit_paise"])
    for cat, enabled in (("electricity", True), ("water", True), ("maintenance", False), ("misc", True)):
        db.exec("INSERT INTO recurring_charge_config(tenancy_id, category, enabled) VALUES (:t, :c, :e)", t=tid, c=cat, e=enabled)
    if d.get("deposit_already_received", True) and d["deposit_paise"] > 0:
        db.scalar("SELECT rg_deposit_txn(:t, 'received', :a, 'recorded at onboarding', :k, :by)", t=tid, a=d["deposit_paise"],
                  k=f"onboard:{tid}", by=actor)
    if d.get("opening_arrears_paise"):
        start_month = d["start_date"].replace(day=1)
        db.scalar("SELECT rg_add_charge(:t, :m, 'opening_balance', :a, 'Opening balance before RentMeezy', :by, :src)",
                  t=tid, m=start_month, a=d["opening_arrears_paise"], by=actor, src="import" if source == "import" else "owner")
    if d.get("notes"):
        db.exec("""INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body, visibility)
                   VALUES (:o, :t, 'tenancy', :t, :by, 'owner', :b, 'owner_private')""", o=owner, t=tid, by=actor, b=d["notes"])
    tenant_user = db.scalar("""SELECT user_id FROM user_contacts WHERE kind = 'mobile' AND value = :p AND verified_at IS NOT NULL
                               AND removed_at IS NULL""", p=d["tenant_mobile"])
    owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=owner)
    if tenant_user:
        notify.enqueue(db, tenant_user, "invitation", {"owner": owner_name, "unit": d["unit_identifier"]}, f"invite:{inv}", owner)
    sms_sent = notify.invite_sms(d["tenant_mobile"], owner_name, d["unit_identifier"]) if not tenant_user else None   # no account yet: text the number now
    db.audit(actor, owner, "tenancy.invited", "tenancy", tid, after={"unit": d["unit_identifier"], "source": source})
    return {"tenancy_id": str(tid), "invitation_id": str(inv), "tenant_registered": tenant_user is not None, "invite_sms_sent": sms_sent,
            "share_text": f"{owner_name} has added you as the tenant of {d['unit_identifier']} on RentMeezy. "
                          f"Install RentMeezy and sign in with {d['tenant_mobile'][3:]} to accept."}


def validate_tenancy_input(body: TenancyIn) -> dict:
    d = body.model_dump()
    if body.unit_id:
        d["unit_identifier"] = body.unit_identifier or ""
    else:
        d["unit_identifier"] = validate_unit_identifier(body.unit_identifier)
    d["unit_kind"] = normalize_kind(body.unit_kind)
    d["tenant_name"] = validate_full_name(body.tenant_name, "tenant_name")
    d["tenant_mobile"] = normalize_indian_mobile(body.tenant_mobile, "tenant_mobile")
    d["tenant_alt_mobile"] = normalize_indian_mobile(body.tenant_alt_mobile, "tenant_alt_mobile") if body.tenant_alt_mobile else None
    d["tenant_email"] = normalize_email(body.tenant_email, "tenant_email") if body.tenant_email else None
    d["monthly_rent_paise"] = parse_inr(body.monthly_rent, field="monthly_rent", allow_zero=True)
    d["deposit_paise"] = parse_inr(body.security_deposit, field="security_deposit", allow_zero=True)
    d["opening_arrears_paise"] = parse_inr(body.opening_arrears, field="opening_arrears", allow_zero=True) if body.opening_arrears not in (None, "") else 0
    d["due_day"] = validate_due_day(body.due_day)
    validate_date_range(body.start_date, body.end_date)
    d["notes"] = validate_note(body.notes, "notes") if body.notes else None
    d["items_provided"] = validate_items(body.items_provided)
    return d


@router.post("/owner/tenancies")
def onboard_tenancy(body: TenancyIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    d = validate_tenancy_input(body)
    if body.end_date is None:
        raise ValidationError("end_date", "required")                    # a new rental needs both its start and its end date
    if d["deposit_paise"] <= 0:
        raise ValidationError("security_deposit", "must_be_positive")    # the advance received must be entered, and cannot be zero
    return create_tenancy(db, scope, d)


@router.get("/owner/renter-check")
def renter_check(mobile: str = Query(max_length=20), scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Is the person with this number a renter whose photo ID is verified? Only a yes or no: nothing else about them is ever shown,
    and the number of checks is limited so the answer cannot be used to look people up."""
    phone = normalize_indian_mobile(mobile, "mobile")
    limiter.check(f"renter-check:{scope.owner_account_id}", 30, 600)
    verified = db.scalar("""SELECT EXISTS (SELECT 1 FROM user_contacts c
                                           JOIN identity_verifications v ON v.user_id = c.user_id AND v.status = 'verified'
                                           WHERE c.kind = 'mobile' AND c.value = :p AND c.verified_at IS NOT NULL AND c.removed_at IS NULL)""", p=phone)
    return {"id_verified": bool(verified)}


@router.get("/owner/tenancies")
def list_tenancies(q: str | None = Query(default=None, max_length=50),
                   status: Literal["live", "invited", "active", "ended", "all"] = "live",
                   scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    where, sp = tenancy_search(q)
    rows = db.all("""SELECT t.id, t.status, t.pay_method, COALESCE(t.pay_method, (SELECT default_pay_method FROM owner_accounts WHERE id = t.owner_account_id)) AS effective_pay_method, t.monthly_rent_paise, t.due_day, t.start_date, t.end_date, u.identifier, u.kind AS unit_kind, u.floor AS unit_floor, p.name AS property_name,
                            p.address, s.name AS tenant_name, s.phone AS tenant_phone, b.balance_paise, b.payable_now_paise, b.deposit_held_paise,
                            (SELECT json_build_object('status', r.status, 'requested_pay_paise', r.requested_pay_paise, 'agreed_pay_paise', r.agreed_pay_paise, 'deferred_paise', r.deferred_paise)
                               FROM rent_relief r WHERE r.tenancy_id = t.id AND r.period_month = date_trunc('month', rg_today())::date
                               ORDER BY (r.status = 'requested') DESC, (r.status = 'approved') DESC, r.created_at DESC LIMIT 1) AS relief
                     FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                     JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                     LEFT JOIN LATERAL (SELECT name, phone FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) s ON true
                     WHERE t.owner_account_id = :o
                       AND (:st = 'all' OR (:st = 'live' AND t.status IN ('invited','active')) OR t.status = :st)
                       AND {where}
                     ORDER BY b.balance_paise DESC, u.identifier LIMIT 300""".replace("{where}", where), o=scope.owner_account_id, st=status, **sp)
    return {"items": [dict(r, balance_display=format_inr(r["balance_paise"])) for r in rows]}


@router.get("/owner/tenancies/{tenancy_id}")
def tenancy_detail(tenancy_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    t = owned_tenancy(db, scope, tenancy_id)
    contact = db.one("SELECT * FROM tenancy_contact_snapshots WHERE tenancy_id = :t ORDER BY created_at DESC LIMIT 1", t=tenancy_id)
    cfg = db.all("SELECT category, enabled, default_amount_paise, carry_forward, tenant_can_submit FROM recurring_charge_config WHERE tenancy_id = :t", t=tenancy_id)
    bal = db.one("SELECT balance_paise, payable_now_paise, deposit_held_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id)
    unit = db.one("""SELECT u.identifier, u.kind, u.floor, p.name, p.address FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = :u""",
                  u=t["unit_id"])
    current_rent = db.scalar("""SELECT COALESCE((SELECT monthly_rent_paise FROM rent_revisions WHERE tenancy_id = :t
                                   AND effective_month <= date_trunc('month', CURRENT_DATE)::date ORDER BY effective_month DESC LIMIT 1), :base)""",
                             t=tenancy_id, base=t["monthly_rent_paise"])
    return {"tenancy": t, "contact": dict(contact) if contact else None, "unit": dict(unit), "charge_config": [dict(c) for c in cfg],
            "current_rent_paise": current_rent, **dict(bal),
            **dict(db.one("SELECT default_upi_id, default_pay_method FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)),
            "effective_pay_method": t.get("pay_method") or db.scalar("SELECT default_pay_method FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)}


class TermsIn(BaseModel):
    version: int
    monthly_rent: str | int | None = None
    rent_effective_month: date | None = None
    due_day: int | None = None
    grace_days: int | None = Field(default=None, ge=0, le=60)
    end_date: date | None = None
    security_deposit: str | int | None = None      # the agreed advance/deposit; money actually received is recorded under Deposit
    items_provided: str | None = Field(default=None, max_length=2500)    # what is provided with the place; an empty text clears the list
    increment_percent: float | None = Field(default=None, ge=0, le=100)  # yearly rent increase used when the agreement is renewed; 0 clears it


def _tell_renter_terms_changed(db: Db, scope: OwnerScope, before, body: "TermsIn", old_rent: int) -> None:
    """Once the renter has accepted, any change to rent, advance, due day, grace days or end date is sent to them right away."""
    if not before["tenant_user_id"]:
        return                                       # still an invitation: the renter has not accepted yet
    changes: list[str] = []
    if body.monthly_rent is not None:
        new = parse_inr(body.monthly_rent, field="monthly_rent", allow_zero=True)
        if new != old_rent:
            m = (body.rent_effective_month or date.today()).replace(day=1)
            changes.append(f"rent {format_inr(old_rent)} to {format_inr(new)} from {m:%b %Y}")
    if body.security_deposit is not None:
        new = parse_inr(body.security_deposit, field="security_deposit", allow_zero=True)
        if new != (before.get("deposit_agreed_paise") or 0):
            changes.append(f"advance {format_inr(before.get('deposit_agreed_paise') or 0)} to {format_inr(new)}")
    if body.due_day is not None and body.due_day != before["due_day"]:
        changes.append(f"due day {before['due_day']} to {body.due_day}")
    if body.grace_days is not None and body.grace_days != before["grace_days"]:
        changes.append(f"grace days {before['grace_days']} to {body.grace_days}")
    if body.end_date is not None and body.end_date != before["end_date"]:
        changes.append(f"end date {body.end_date:%d-%m-%Y}")
    if body.increment_percent is not None and float(body.increment_percent or 0) != float(before.get("increment_percent") or 0):
        changes.append(f"yearly rent increase {body.increment_percent:g}%" if body.increment_percent else "yearly rent increase removed")
    if body.items_provided is not None and (validate_items(body.items_provided) or "") != (before.get("items_provided") or ""):
        changes.append("the list of items provided with the place was updated")
    if not changes:
        return
    owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
    unit = db.scalar("SELECT u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.id = :t", t=before["id"])
    notify.enqueue(db, before["tenant_user_id"], "terms_changed", {"owner": owner_name, "unit": unit, "change": "; ".join(changes)},
                   f"terms:{before['id']}:{before['version'] + 1}", scope.owner_account_id)


@router.patch("/owner/tenancies/{tenancy_id}")
def update_terms(tenancy_id: UUID, body: TermsIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    t = owned_tenancy(db, scope, tenancy_id, lock=True)
    if t["version"] != body.version:
        raise AppError("STALE_VERSION", "tenancy changed elsewhere; reload")
    db.scalar("SELECT rg_require_owner_writable(:o)", o=scope.owner_account_id)
    old_rent = db.scalar("""SELECT COALESCE((SELECT monthly_rent_paise FROM rent_revisions WHERE tenancy_id = :t
                            AND effective_month <= date_trunc('month', CURRENT_DATE)::date ORDER BY effective_month DESC LIMIT 1), :base)""",
                         t=tenancy_id, base=t["monthly_rent_paise"])
    if body.monthly_rent is not None:
        amount = parse_inr(body.monthly_rent, field="monthly_rent", allow_zero=True)
        month = (body.rent_effective_month or date.today()).replace(day=1)
        if month < t["start_date"].replace(day=1):
            raise AppError("VALIDATION", "a rent change cannot start before the rental itself started", fields=[{"field": "rent_effective_month", "code": "before_start"}])
        db.exec("""INSERT INTO rent_revisions(tenancy_id, effective_month, monthly_rent_paise, created_by) VALUES (:t, :m, :a, :by)
                   ON CONFLICT (tenancy_id, effective_month) DO UPDATE SET monthly_rent_paise = EXCLUDED.monthly_rent_paise""",
                t=tenancy_id, m=month, a=amount, by=scope.user.id)
    if body.security_deposit is not None:
        dep = parse_inr(body.security_deposit, field="security_deposit", allow_zero=True)
        db.exec("UPDATE tenancies SET deposit_agreed_paise = :a WHERE id = :t", a=dep, t=tenancy_id)
        db.exec("UPDATE deposits SET agreed_paise = :a WHERE tenancy_id = :t", a=dep, t=tenancy_id)
    new_items = validate_items(body.items_provided) if body.items_provided is not None else None
    if body.items_provided is not None:
        db.exec("UPDATE tenancies SET items_provided = :i WHERE id = :t", i=new_items, t=tenancy_id)
    if body.increment_percent is not None:
        db.exec("UPDATE tenancies SET increment_percent = :p WHERE id = :t", p=body.increment_percent or None, t=tenancy_id)
    if body.end_date is not None:
        validate_date_range(t["start_date"], body.end_date)
    db.exec("""UPDATE tenancies SET due_day = COALESCE(:d, due_day), grace_days = COALESCE(:g, grace_days),
               end_date = COALESCE(:e, end_date), version = version + 1 WHERE id = :t""",
            d=validate_due_day(body.due_day) if body.due_day is not None else None, g=body.grace_days, e=body.end_date, t=tenancy_id)
    if body.end_date is not None and body.end_date != t["end_date"] and t["status"] == "active":
        # bring the bills in line with the new end date: credit rent past it, pro-rate the last month, and bill an extended stay now
        from .billing import backfill_invoices
        db.scalar("SELECT rg_resync_rent(:t, :by)", t=tenancy_id, by=scope.user.id)
        backfill_invoices(db, tenancy_id)
    db.audit(scope.user.id, scope.owner_account_id, "tenancy.terms_updated", "tenancy", tenancy_id,
             before={k: t[k] for k in ("monthly_rent_paise", "due_day", "grace_days", "end_date")}, after=body.model_dump())
    _tell_renter_terms_changed(db, scope, t, body, old_rent)
    return tenancy_detail(tenancy_id, scope, db)


class ChargeConfigIn(BaseModel):
    category: Literal["electricity", "water", "maintenance", "misc"]
    enabled: bool
    default_amount: str | int | None = None
    carry_forward: bool = False
    tenant_can_submit: bool = True


@router.put("/owner/tenancies/{tenancy_id}/charge-config")
def set_charge_config(tenancy_id: UUID, body: list[ChargeConfigIn], scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    owned_tenancy(db, scope, tenancy_id)
    for c in body:
        amt = parse_inr(c.default_amount, field="default_amount", allow_zero=True) if c.default_amount not in (None, "") else None
        db.exec("""INSERT INTO recurring_charge_config(tenancy_id, category, enabled, default_amount_paise, carry_forward, tenant_can_submit)
                   VALUES (:t, :c, :e, :a, :cf, :ts) ON CONFLICT (tenancy_id, category) DO UPDATE SET enabled = EXCLUDED.enabled,
                   default_amount_paise = EXCLUDED.default_amount_paise, carry_forward = EXCLUDED.carry_forward,
                   tenant_can_submit = EXCLUDED.tenant_can_submit""",
                t=tenancy_id, c=c.category, e=c.enabled, a=amt, cf=c.carry_forward and c.category == "maintenance", ts=c.tenant_can_submit)
    return tenancy_detail(tenancy_id, scope, db)


class TenantContactIn(BaseModel):
    name: str = Field(max_length=400)
    alt_phone: str | None = None
    email: str | None = None
    address: str | None = Field(default=None, max_length=1000)


@router.put("/owner/tenancies/{tenancy_id}/contact")
def edit_tenant_contact(tenancy_id: UUID, body: TenantContactIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Owner's own record of the tenant for THIS tenancy. Does not touch the tenant's global
    profile, login number or notification preferences; past receipts keep their snapshot."""
    t = owned_tenancy(db, scope, tenancy_id)
    db.exec("""INSERT INTO tenancy_contact_snapshots(tenancy_id, name, phone, alt_phone, email, address, created_by)
               VALUES (:t, :n, :p, :a, :e, :ad, :by)""", t=tenancy_id, n=validate_full_name(body.name, "name"), p=t["invited_phone"],
            a=normalize_indian_mobile(body.alt_phone, "alt_phone") if body.alt_phone else None,
            e=normalize_email(body.email) if body.email else None, ad=validate_address(body.address, required=False), by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "tenancy.contact_edited", "tenancy", tenancy_id)
    return tenancy_detail(tenancy_id, scope, db)


class ProposalIn(BaseModel):
    field: Literal["secondary_mobile", "primary_mobile", "email"]
    new_value: str = Field(max_length=254)


@router.post("/owner/tenancies/{tenancy_id}/contact-proposals")
def propose_contact_change(tenancy_id: UUID, body: ProposalIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    t = owned_tenancy(db, scope, tenancy_id)
    if t["tenant_user_id"] is None:
        raise AppError("INVALID_STATE", "tenant has not accepted yet; edit the invitation instead")
    value = normalize_email(body.new_value) if body.field == "email" else normalize_indian_mobile(body.new_value, "new_value")
    pid = db.scalar("""INSERT INTO contact_change_proposals(tenancy_id, proposed_by, field, new_value) VALUES (:t, :by, :f, :v) RETURNING id""",
                    t=tenancy_id, by=scope.user.id, f=body.field, v=value)
    return {"proposal_id": str(pid), "status": "pending_tenant_approval"}


class EndIn(BaseModel):
    deposit_note: str | None = Field(default=None, max_length=250)      # why any deposit is held back, shown to the renter too
    handover_note: str | None = Field(default=None, max_length=250)     # anything else about the move-out


@router.post("/owner/tenancies/{tenancy_id}/end")
def end_tenancy(tenancy_id: UUID, end_date: date, body: EndIn | None = None, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Close a renter as vacated. The unit becomes free for a new renter. Notes are kept on the record and shown to both sides."""
    t = owned_tenancy(db, scope, tenancy_id)
    db.scalar("SELECT rg_end_tenancy(:t, :d, :by)", t=tenancy_id, d=end_date, by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "tenancy.ended", "tenancy", tenancy_id, after={"end_date": str(end_date)})
    for label, text_ in (("Deposit", body.deposit_note if body else None), ("Vacated", body.handover_note if body else None)):
        if text_ and text_.strip():
            db.exec("""INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body, visibility)
                       VALUES (:o, :t, 'tenancy', :t, :by, 'owner', :b, 'shared')""",
                    o=scope.owner_account_id, t=tenancy_id, by=scope.user.id, b=clean_text(f"{label}: {text_.strip()}")[:250])
    if t["tenant_user_id"]:
        unit = db.scalar("SELECT identifier FROM units WHERE id = :u", u=t["unit_id"])
        notify.enqueue(db, t["tenant_user_id"], "tenancy_closed", {"unit": unit}, f"closed:{tenancy_id}", scope.owner_account_id)
    bal = db.one("SELECT balance_paise, deposit_held_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id)
    return {"status": "ended", "final_balance_paise": bal["balance_paise"], "deposit_held_paise": bal["deposit_held_paise"],
            "next": "settle dues from deposit and record the refund"}


@router.post("/owner/tenancies/{tenancy_id}/resend-invite")
def resend_invite(tenancy_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Send the invitation text/notification again while the renter has not accepted. At most once every 10 minutes."""
    t = owned_tenancy(db, scope, tenancy_id, lock=True)
    if t["status"] != "invited":
        raise AppError("INVALID_STATE", "This renter has already responded.", status=409)
    if db.scalar("""SELECT 1 FROM audit_events WHERE entity_id = :t AND action = 'tenancy.invite_resent' AND created_at > now() - interval '10 minutes' LIMIT 1""", t=tenancy_id):
        raise AppError("RATE_LIMITED", "The invitation was sent a moment ago. Please wait a few minutes.", status=429)
    owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
    unit = db.scalar("SELECT identifier FROM units WHERE id = :u", u=t["unit_id"])
    tenant_user = db.scalar("""SELECT user_id FROM user_contacts WHERE kind = 'mobile' AND value = :p AND verified_at IS NOT NULL AND removed_at IS NULL""", p=t["invited_phone"])
    if tenant_user:
        notify.enqueue(db, tenant_user, "invitation", {"owner": owner_name, "unit": unit}, f"invite-again:{tenancy_id}:{datetime.now().timestamp():.0f}", scope.owner_account_id)
        sent = True
    else:
        sent = notify.invite_sms(t["invited_phone"], owner_name, unit)
    db.audit(scope.user.id, scope.owner_account_id, "tenancy.invite_resent", "tenancy", tenancy_id)
    return {"status": "sent" if sent else "failed"}


@router.post("/owner/tenancies/{tenancy_id}/cancel-invite")
def cancel_invite(tenancy_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Remove a renter who was added by mistake (wrong number). Only while the invitation is still unaccepted; the address becomes free again."""
    t = owned_tenancy(db, scope, tenancy_id, lock=True)
    if t["status"] != "invited":
        raise AppError("INVALID_STATE", "This renter has already accepted. Use End rental (vacate) instead.", status=409)
    db.scalar("SELECT rg_end_tenancy(:t, :d, :by)", t=tenancy_id, d=date.today(), by=scope.user.id)   # an unaccepted tenancy is cancelled, not ended
    db.audit(scope.user.id, scope.owner_account_id, "tenancy.invite_cancelled", "tenancy", tenancy_id)
    return {"status": "cancelled"}


# ───────────────────────── tenant side ─────────────────────────
@router.get("/tenant/invitations")
def my_invitations(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    """Only enough to recognise the invitation — no rent, balances or address until accepted."""
    rows = db.all("""SELECT i.id, o.display_name AS owner_name, u.identifier AS unit, i.created_at,
                            COALESCE((SELECT v.status FROM owner_verifications v WHERE v.owner_account_id = o.id), 'none') AS owner_verification,
                            i.phone AS your_mobile
                     FROM tenancy_invitations i JOIN tenancies t ON t.id = i.tenancy_id
                     JOIN owner_accounts o ON o.id = t.owner_account_id JOIN units u ON u.id = t.unit_id
                     JOIN user_contacts c ON c.value = i.phone AND c.kind = 'mobile' AND c.verified_at IS NOT NULL AND c.removed_at IS NULL
                     WHERE c.user_id = :u AND i.status = 'pending' ORDER BY i.created_at""", u=user.id)
    return {"items": [dict(r) for r in rows]}


@router.post("/tenant/invitations/{invitation_id}/{decision}")
def decide_invitation(invitation_id: UUID, decision: Literal["accept", "reject"], user: CurrentUser = Depends(complete_user),
                      db: Db = Depends(get_db)) -> dict:
    if decision == "accept":
        tid = db.scalar("SELECT rg_accept_invitation(:i, :u)", i=invitation_id, u=user.id)
        db.ctx_add_tenancy(tid)                             # row-level security: this tenancy is now theirs
        from .billing import backfill_invoices
        backfill_invoices(db, tid)                          # a tenancy that started in the past owes its earlier months too
        db.audit(user.id, None, "tenancy.accepted", "tenancy", tid)
        return {"status": "accepted", "tenancy_id": str(tid)}
    db.scalar("SELECT rg_reject_invitation(:i, :u)", i=invitation_id, u=user.id)
    return {"status": "rejected"}


@router.get("/tenant/rentals")
def my_rentals(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    rows = db.all("""SELECT t.id, t.status, t.monthly_rent_paise, t.due_day, t.start_date, t.end_date, u.identifier, u.kind, u.floor,
                            p.name AS property_name, p.address, o.display_name AS owner_name, o.id AS _owner_id,
                            COALESCE((SELECT v.status FROM owner_verifications v WHERE v.owner_account_id = o.id), 'none') AS owner_verification, o.default_upi_id AS _default_upi,
                            (SELECT json_build_object('id', v.id, 'status', v.status, 'move_out_date', v.move_out_date, 'owner_note', v.owner_note)
                               FROM vacate_requests v WHERE v.tenancy_id = t.id AND v.status IN ('requested','declined') ORDER BY (v.status = 'requested') DESC, v.created_at DESC LIMIT 1) AS vacate,
                            t.invited_phone AS your_mobile, COALESCE(t.pay_method, o.default_pay_method) AS pay_method, CASE WHEN COALESCE(t.pay_method, o.default_pay_method) = 'upi' THEN COALESCE(t.pay_upi_id, o.default_upi_id) END AS pay_upi_id, t.items_provided, t.increment_percent, b.balance_paise, b.payable_now_paise, b.deposit_held_paise,
                            (SELECT json_build_object('status', r.status, 'requested_pay_paise', r.requested_pay_paise, 'agreed_pay_paise', r.agreed_pay_paise, 'deferred_paise', r.deferred_paise)
                               FROM rent_relief r WHERE r.tenancy_id = t.id AND r.period_month = date_trunc('month', rg_today())::date
                               ORDER BY (r.status = 'requested') DESC, (r.status = 'approved') DESC, r.created_at DESC LIMIT 1) AS relief,
                            (SELECT json_build_object('period_month', period_month, 'due_date', due_date, 'open_paise', open_paise, 'status', status)
                               FROM v_invoice_status WHERE tenancy_id = t.id ORDER BY period_month DESC LIMIT 1) AS latest_invoice
                     FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                     JOIN owner_accounts o ON o.id = t.owner_account_id JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                     WHERE t.tenant_user_id = :u AND t.status IN ('active','ended')
                     ORDER BY (t.status = 'active') DESC, o.display_name, u.identifier""", u=user.id)
    # A renter sees ONLY their own occupied unit, its address, their bills, and the owner's display name + verified badge.
    # No owner phone, no internal owner id (a keyed, opaque key groups rentals of the same owner), no other units or properties.
    from ..core.config import get_settings
    from ..domain.signatures import hmac_sha256_hex
    from .payments import online_available
    secret = get_settings().file_signing_secret
    items = []
    for r in rows:
        d = dict(r, balance_display=format_inr(r["balance_paise"]))
        d["owner_ref"] = hmac_sha256_hex(secret, str(d.pop("_owner_id")).encode())[:16]
        # How THIS renter pays: 'upi' (the owner's UPI ID, free), 'cash', 'online' (only with a live provider) or 'none'.
        # The sandbox checkout is a demo, so it is never offered: a renter with no live online option pays the owner's UPI ID.
        default_upi = d.pop("_default_upi")
        if d["pay_method"] == "upi":
            d["pay_mode"] = "upi"
        elif d["pay_method"] == "cash":
            d["pay_mode"] = "cash"
        elif d["pay_method"] == "online" and online_available():
            d["pay_mode"] = "online"
        elif default_upi:
            d["pay_mode"], d["pay_upi_id"] = "upi", default_upi
        else:
            d["pay_mode"] = "none"
        items.append(d)
    return {"items": items}


@router.get("/tenant/contact-proposals")
def my_proposals(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    return {"items": [dict(r) for r in db.all(
        """SELECT cp.id, cp.field, cp.new_value, cp.created_at, o.display_name AS owner_name FROM contact_change_proposals cp
           JOIN tenancies t ON t.id = cp.tenancy_id JOIN owner_accounts o ON o.id = t.owner_account_id
           WHERE t.tenant_user_id = :u AND cp.status = 'pending'""", u=user.id)]}


@router.post("/tenant/contact-proposals/{proposal_id}/{decision}")
def decide_proposal(proposal_id: UUID, decision: Literal["accept", "reject"], user: CurrentUser = Depends(complete_user),
                    db: Db = Depends(get_db)) -> dict:
    """Accepting never applies the change silently: secondary mobile/email are added UNVERIFIED and
    the tenant verifies them by OTP; a primary-number change must go through the tenant's own
    Change Primary Mobile flow."""
    cp = db.must("""SELECT cp.* FROM contact_change_proposals cp JOIN tenancies t ON t.id = cp.tenancy_id
                    WHERE cp.id = :p AND t.tenant_user_id = :u AND cp.status = 'pending' FOR UPDATE""", "proposal", p=proposal_id, u=user.id)
    db.exec("UPDATE contact_change_proposals SET status = :s, decided_at = now() WHERE id = :p",
            s="accepted" if decision == "accept" else "rejected", p=proposal_id)
    if decision == "reject":
        return {"status": "rejected"}
    if cp["field"] == "primary_mobile":
        return {"status": "accepted", "next": "start_change_primary_mobile", "new_phone": cp["new_value"]}
    from .identity import ContactIn, add_contact
    out = add_contact(ContactIn(kind="email" if cp["field"] == "email" else "mobile", value=cp["new_value"]), user, db)
    return {"status": "accepted", "next": "verify_contact", **out}


# ───────────────────────── Excel import ─────────────────────────
@router.get("/owner/imports/template")
def import_template(_: OwnerScope = Depends(owner_scope)) -> Response:
    return Response(excel_import.build_template(),
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": 'attachment; filename="rentmeezy-tenancy-import.xlsx"'})


def _import_context(db: Db, owner: UUID) -> dict:
    existing = {(r["a"], r["i"]) for r in db.all(
        """SELECT lower(p.address) AS a, lower(u.identifier) AS i FROM units u JOIN properties p ON p.id = u.property_id
           WHERE u.owner_account_id = :o""", o=owner)}
    live = {(r["a"], r["i"]) for r in db.all(
        """SELECT lower(p.address) AS a, lower(u.identifier) AS i FROM tenancies t JOIN units u ON u.id = t.unit_id
           JOIN properties p ON p.id = u.property_id WHERE t.owner_account_id = :o AND t.status IN ('invited','active')""", o=owner)}
    phones = {r["value"] for r in db.all("""SELECT c.value FROM user_contacts c JOIN owner_memberships m ON m.user_id = c.user_id
                                            WHERE m.owner_account_id = :o AND c.kind = 'mobile'""", o=owner)}
    state = db.scalar("SELECT rg_owner_write_state(:o)", o=owner)
    cap = db.one("""SELECT s.max_units - (SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active') AS remaining
                    FROM owner_subscriptions s WHERE s.owner_account_id = :o AND s.status = 'active'""", o=owner)
    return {"existing_unit_keys": existing, "units_with_live_tenancy": live, "owner_phones": phones,
            "remaining_capacity": cap["remaining"] if cap and state == "active" else None}


@router.post("/owner/imports")
async def upload_import(file: UploadFile = File(...), scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    content = await file.read(excel_import.MAX_FILE_BYTES + 1)
    try:
        preview = excel_import.parse_workbook(content, **_import_context(db, scope.owner_account_id))
    except excel_import.ImportFileError as e:
        raise AppError("IMPORT_FILE", e.code, **e.params) from e
    jid = db.scalar("""INSERT INTO import_jobs(owner_account_id, created_by, file_sha256, total_rows, valid_rows, new_units)
                       VALUES (:o, :u, :h, :t, :v, :n) RETURNING id""", o=scope.owner_account_id, u=scope.user.id, h=preview.file_sha256,
                    t=len(preview.rows), v=sum(r.valid for r in preview.rows), n=preview.new_units)
    for r in preview.rows:
        db.exec("""INSERT INTO import_rows(job_id, row_number, data, errors, warnings, status)
                   VALUES (:j, :n, CAST(:d AS jsonb), CAST(:e AS jsonb), CAST(:w AS jsonb), :s)""",
                j=jid, n=r.row_number, d=json.dumps(r.data, default=str, ensure_ascii=False), e=json.dumps(r.errors),
                w=json.dumps(r.warnings), s="valid" if r.valid else "invalid")
    return {"job_id": str(jid), "file_errors": preview.file_errors, "can_commit": preview.can_commit, "new_units": preview.new_units,
            "remaining_capacity": preview.remaining_capacity,
            "rows": [{"row": r.row_number, "valid": r.valid, "errors": r.errors, "warnings": r.warnings,
                      "unit": r.data.get("unit_identifier"), "tenant": r.data.get("tenant_name")} for r in preview.rows]}


@router.post("/owner/imports/{job_id}/commit")
def commit_import(job_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    job = db.must("SELECT * FROM import_jobs WHERE id = :j AND owner_account_id = :o FOR UPDATE", "import", j=job_id, o=scope.owner_account_id)
    if job["status"] != "previewed":
        raise AppError("INVALID_STATE", f"import already {job['status']}")
    ctx = _import_context(db, scope.owner_account_id)
    if ctx["remaining_capacity"] is None:
        raise AppError("SUBSCRIPTION_REQUIRED", "an active plan is needed to import units")
    rows = db.all("SELECT * FROM import_rows WHERE job_id = :j AND status = 'valid' ORDER BY row_number", j=job_id)
    imported, failed = 0, []
    for r in rows:
        d = dict(r["data"])
        d["start_date"] = date.fromisoformat(d["start_date"])
        d["end_date"] = date.fromisoformat(d["end_date"]) if d.get("end_date") else None
        d["property"] = {"address": d["property_address"], "name": d.get("property_name"), "city": d.get("city"),
                         "state": d.get("state"), "pincode": d.get("pincode")}
        sp = db.conn.begin_nested()          # one bad row never rolls back the good ones
        try:
            out = create_tenancy(db, scope, d, source="import")
            sp.commit()
            db.exec("UPDATE import_rows SET status = 'imported', tenancy_id = :t WHERE id = :i", t=out["tenancy_id"], i=r["id"])
            imported += 1
        except AppError as e:
            sp.rollback()
            failed.append({"row": r["row_number"], "code": e.code, "message": e.message})
            db.exec("UPDATE import_rows SET status = 'skipped', errors = CAST(:e AS jsonb) WHERE id = :i",
                    e=json.dumps([{"code": e.code, "message": e.message}]), i=r["id"])
        except Exception as e:  # noqa: BLE001 - DB constraint errors per row
            sp.rollback()
            from ..core.db import translate_db_error
            mapped = translate_db_error(e) if hasattr(e, "orig") else None
            code = mapped.code if mapped else "ROW_FAILED"
            failed.append({"row": r["row_number"], "code": code})
            db.exec("UPDATE import_rows SET status = 'skipped', errors = CAST(:e AS jsonb) WHERE id = :i",
                    e=json.dumps([{"code": code}]), i=r["id"])
    db.exec("UPDATE import_jobs SET status = 'committed', committed_at = now() WHERE id = :j", j=job_id)
    db.audit(scope.user.id, scope.owner_account_id, "import.committed", "import_job", job_id, after={"imported": imported, "failed": len(failed)})
    return {"imported": imported, "failed": failed}


@router.get("/owner/imports/{job_id}")
def get_import(job_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    job = db.must("SELECT * FROM import_jobs WHERE id = :j AND owner_account_id = :o", "import", j=job_id, o=scope.owner_account_id)
    rows = db.all("SELECT row_number, status, errors, warnings, data->>'unit_identifier' AS unit FROM import_rows WHERE job_id = :j ORDER BY row_number", j=job_id)
    return {"job": dict(job), "rows": [dict(r) for r in rows]}


def new_idempotency_key() -> str:
    return secrets.token_urlsafe(16)
