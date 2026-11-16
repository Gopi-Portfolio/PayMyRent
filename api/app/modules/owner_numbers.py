"""Owner numbers. An owner account can have up to `max_owner_numbers` people (default 2: the subscriber + one more), identified by
mobile number. Declared at checkout or later. Only someone who signs in with a declared number (OTP-verified) is attached as a
co-owner of this account; nobody else can ever become an owner of it. Removing a number ends that person's access immediately."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import OwnerScope, owner_scope
from ..core.config import get_settings
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.validation import normalize_indian_mobile

router = APIRouter(prefix="/api/v1", tags=["owner-numbers"])


def claim_owner_memberships(db: Db, user_id) -> None:  # noqa: ANN001
    """Called whenever a user's session/profile is loaded. If one of the user's VERIFIED mobile numbers is a declared owner number
    of some owner account, attach them to that account as a co-owner (idempotent)."""
    rows = db.all("""SELECT a.owner_account_id, o.primary_user_id
                     FROM owner_allowed_numbers a JOIN user_contacts c ON c.value = a.phone AND c.kind = 'mobile'
                          AND c.verified_at IS NOT NULL AND c.removed_at IS NULL AND c.user_id = :u
                     JOIN owner_accounts o ON o.id = a.owner_account_id
                     WHERE a.removed_at IS NULL AND NOT EXISTS (
                           SELECT 1 FROM owner_memberships m WHERE m.owner_account_id = a.owner_account_id AND m.user_id = :u AND m.status = 'active')""", u=user_id)
    for r in rows:
        db.exec("""INSERT INTO owner_memberships(owner_account_id, user_id, role, status, granted_by) VALUES (:o, :u, 'co_owner', 'active', :g)
                   ON CONFLICT (owner_account_id, user_id) DO UPDATE SET status = 'active', role = 'co_owner', granted_by = :g""",
                 o=r["owner_account_id"], u=user_id, g=r["primary_user_id"])
        db.exec("INSERT INTO user_roles(user_id, role) VALUES (:u, 'owner') ON CONFLICT DO NOTHING", u=user_id)
        db.audit(user_id, r["owner_account_id"], "owner_number.joined", "owner_account", r["owner_account_id"])


Relationship = Literal["brother", "sister", "parent", "son", "daughter", "friend", "family"]


class CoOwnerIn(BaseModel):
    """The second owner: their mobile number, and who they are to the primary owner (required)."""
    phone: str = Field(max_length=20)
    relationship: Relationship


def set_owner_numbers(db: Db, scope: OwnerScope, co_owners: list[CoOwnerIn]) -> dict:
    """Replace the declared extra owner numbers of this account. Only the subscriber (role 'owner') may do this. This is the only
    way a second owner is ever entered, and every one needs a relationship (brother, sister, parent, son, daughter, friend, family)."""
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account's main owner can change owner numbers")
    s = get_settings()
    o = scope.owner_account_id
    limiter.check(f"ownernum:{scope.user.id}", 10, 3600)
    primary = db.scalar("SELECT value FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND is_primary AND removed_at IS NULL", u=scope.user.id)
    wanted: list[str] = []
    rel: dict[str, str] = {}
    for c in co_owners:
        p = normalize_indian_mobile(c.phone, "owner_mobile")
        if p == primary:
            raise AppError("VALIDATION", "this is already your own number")
        if db.scalar("""SELECT 1 FROM tenancies WHERE owner_account_id = :o AND invited_phone = :p AND status IN ('invited','active') LIMIT 1""", o=o, p=p):
            raise AppError("VALIDATION", "this number belongs to a renter of this property, so it cannot also be an owner number", status=409)
        if p not in wanted:
            wanted.append(p)
            rel[p] = c.relationship
    if len(wanted) > s.max_owner_numbers - 1:
        raise AppError("VALIDATION", f"at most {s.max_owner_numbers} owner numbers are allowed in total (yours + {s.max_owner_numbers - 1})")
    current = {r["phone"] for r in db.all("SELECT phone FROM owner_allowed_numbers WHERE owner_account_id = :o AND removed_at IS NULL", o=o)}
    for p in wanted:
        if p not in current:
            db.exec("""INSERT INTO owner_allowed_numbers(owner_account_id, phone, added_by, relationship) VALUES (:o, :p, :u, :r)
                       ON CONFLICT (owner_account_id, phone) DO UPDATE SET removed_at = NULL, added_by = :u, created_at = now(), relationship = :r""",
                    o=o, p=p, u=scope.user.id, r=rel[p])
            db.audit(scope.user.id, o, "owner_number.added", "owner_account", o, after={"phone_last4": p[-4:], "relationship": rel[p]})
        else:
            db.exec("UPDATE owner_allowed_numbers SET relationship = :r WHERE owner_account_id = :o AND phone = :p", o=o, p=p, r=rel[p])
    for p in current - set(wanted):
        db.exec("UPDATE owner_allowed_numbers SET removed_at = now() WHERE owner_account_id = :o AND phone = :p", o=o, p=p)
        # access ends now: revoke a co-owner membership held through this number (never the main owner's)
        db.exec("""UPDATE owner_memberships m SET status = 'revoked' FROM user_contacts c
                   WHERE m.owner_account_id = :o AND m.role = 'co_owner' AND m.status = 'active' AND c.user_id = m.user_id
                     AND c.kind = 'mobile' AND c.value = :p AND c.removed_at IS NULL""", o=o, p=p)
        db.audit(scope.user.id, o, "owner_number.removed", "owner_account", o, after={"phone_last4": p[-4:]})
    # someone who already has an account with a newly declared number joins right away
    for p in wanted:
        uid = db.scalar("""SELECT user_id FROM user_contacts WHERE kind = 'mobile' AND value = :p AND verified_at IS NOT NULL AND removed_at IS NULL""", p=p)
        if uid:
            claim_owner_memberships(db, uid)
    return owner_numbers_view(db, scope)


def owner_numbers_view(db: Db, scope: OwnerScope) -> dict:
    o = scope.owner_account_id
    members = db.all("""SELECT m.role, u.full_name, (SELECT c.value FROM user_contacts c WHERE c.user_id = u.id AND c.kind = 'mobile' AND c.is_primary AND c.removed_at IS NULL) AS phone
                        FROM owner_memberships m JOIN users u ON u.id = m.user_id WHERE m.owner_account_id = :o AND m.status = 'active'
                        ORDER BY (m.role = 'owner') DESC, u.full_name""", o=o)
    declared = db.all("""SELECT a.phone, a.relationship, EXISTS (SELECT 1 FROM user_contacts c JOIN owner_memberships m ON m.user_id = c.user_id AND m.owner_account_id = a.owner_account_id AND m.status = 'active'
                                                 WHERE c.value = a.phone AND c.kind = 'mobile' AND c.verified_at IS NOT NULL AND c.removed_at IS NULL) AS joined
                         FROM owner_allowed_numbers a WHERE a.owner_account_id = :o AND a.removed_at IS NULL ORDER BY a.created_at""", o=o)
    mx = get_settings().max_owner_numbers
    return {"max": mx, "slots_left": max(mx - 1 - len(declared), 0),
            "owners": [{"name": m["full_name"], "phone": m["phone"], "role": m["role"]} for m in members],
            "declared": [{"phone": d["phone"], "relationship": d["relationship"], "joined": d["joined"]} for d in declared],
            "can_edit": scope.membership_role == "owner"}


class OwnerNumbersIn(BaseModel):
    co_owners: list[CoOwnerIn] = Field(default_factory=list, max_length=5)
    otp_code: str | None = None          # the code sent to the main owner's own mobile


@router.get("/owner/owner-numbers")
def get_owner_numbers(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    return owner_numbers_view(db, scope)


@router.put("/owner/owner-numbers")
def put_owner_numbers(body: OwnerNumbersIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    from .action_otp import require_action_otp
    if scope.membership_role == "owner":
        require_action_otp(db, scope.user.id, "co_owner", body.otp_code)       # set_owner_numbers refuses non-owners itself
    return set_owner_numbers(db, scope, body.co_owners)
