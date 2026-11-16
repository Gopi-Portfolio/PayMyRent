"""Hand the owner account to someone else, so an owner who is leaving does not have to close every renter.

The whole account moves (places, renters, bills, history). What does NOT move: the old owner's subscription (it ends, so the new owner must pay
for a plan before using anything; until then the account is read-only), the old owner's identity details (PAN etc. are removed, the new owner
gives their own), and the old owner's co-owners (their access ends). Renters are told. The old owner's access ends at once."""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import OwnerScope, owner_scope
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.validation import normalize_indian_mobile
from . import notify

router = APIRouter(prefix="/api/v1", tags=["owner-transfer"])


@router.get("/owner/close-preview")
def close_preview(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """What closing would affect: shown before the owner is asked whether to transfer."""
    o = scope.owner_account_id
    return {"renters": db.scalar("SELECT count(*) FROM tenancies WHERE owner_account_id = :o AND status IN ('invited','active')", o=o),
            "places": db.scalar("SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active'", o=o),
            "can_transfer": scope.membership_role == "owner"}


def complete_transfer(db: Db, transfer_id: UUID, to_user: UUID) -> None:
    t = db.must("SELECT * FROM owner_transfers WHERE id = :i AND status = 'pending' FOR UPDATE", "transfer", i=transfer_id)
    o = t["owner_account_id"]
    name = db.scalar("SELECT COALESCE(full_name, 'Owner') FROM users WHERE id = :u", u=to_user)
    db.exec("UPDATE owner_accounts SET primary_user_id = :u, display_name = :n WHERE id = :o", u=to_user, n=name, o=o)
    db.exec("""INSERT INTO owner_memberships(owner_account_id, user_id, role, status, granted_by) VALUES (:o, :u, 'owner', 'active', :g)
               ON CONFLICT (owner_account_id, user_id) DO UPDATE SET status = 'active', role = 'owner'""", o=o, u=to_user, g=t["from_user_id"])
    db.exec("INSERT INTO user_roles(user_id, role) VALUES (:u, 'owner') ON CONFLICT DO NOTHING", u=to_user)
    db.exec("UPDATE owner_transfers SET status = 'completed', to_user_id = :u, completed_at = now() WHERE id = :i", u=to_user, i=transfer_id)
    db.audit(to_user, o, "owner.transfer_completed", "owner_account", o)


def claim_transfers(db: Db, user_id: UUID) -> None:
    """When the person the account was handed to signs in with that number, the account becomes theirs (if they have no owner account of their own)."""
    if db.scalar("SELECT 1 FROM owner_accounts WHERE primary_user_id = :u", u=user_id):
        return
    row = db.one("""SELECT t.id FROM owner_transfers t JOIN user_contacts c ON c.value = t.to_phone AND c.kind = 'mobile' AND c.verified_at IS NOT NULL
                    AND c.removed_at IS NULL AND c.user_id = :u WHERE t.status = 'pending' ORDER BY t.created_at LIMIT 1""", u=user_id)
    if row:
        complete_transfer(db, row["id"], user_id)


class TransferIn(BaseModel):
    phone: str = Field(max_length=20)
    otp_code: str | None = None          # the code sent to the owner's own mobile


@router.post("/owner/transfer")
def transfer_owner_account(body: TransferIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    from .action_otp import require_action_otp
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account's main owner can transfer it")
    limiter.check(f"transfer:{scope.user.id}", 5, 3600)
    o = scope.owner_account_id
    phone = normalize_indian_mobile(body.phone, "phone")
    own = db.scalar("SELECT 1 FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND value = :p AND removed_at IS NULL", u=scope.user.id, p=phone)
    if own:
        raise AppError("VALIDATION", "this is your own number", fields=[{"field": "phone", "code": "own_number"}])
    if db.scalar("SELECT 1 FROM tenancies WHERE owner_account_id = :o AND invited_phone = :p AND status IN ('invited','active') LIMIT 1", o=o, p=phone):
        raise AppError("VALIDATION", "this number belongs to a renter of this property, so it cannot also be the owner", status=409)
    target = db.scalar("SELECT user_id FROM user_contacts WHERE kind = 'mobile' AND value = :p AND verified_at IS NOT NULL AND removed_at IS NULL", p=phone)
    if target and db.scalar("SELECT 1 FROM owner_accounts WHERE primary_user_id = :u", u=target):
        raise AppError("CONFLICT", "this number already has its own owner account, so it cannot take over another one", status=409)
    if db.scalar("SELECT 1 FROM owner_transfers WHERE owner_account_id = :o AND status = 'pending'", o=o):
        raise AppError("CONFLICT", "a transfer to another number is already waiting", status=409)
    require_action_otp(db, scope.user.id, "transfer", body.otp_code)                       # last, so a wrong form never burns a code

    tid = db.scalar("INSERT INTO owner_transfers(owner_account_id, from_user_id, to_phone) VALUES (:o, :u, :p) RETURNING id", o=o, u=scope.user.id, p=phone)
    owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=o)
    # renters hear about it first (while this owner can still read them)
    for r in db.all("""SELECT t.id, t.tenant_user_id, u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id
                       WHERE t.owner_account_id = :o AND t.status = 'active' AND t.tenant_user_id IS NOT NULL""", o=o):
        notify.enqueue(db, r["tenant_user_id"], "owner_transferred", {"owner": owner_name, "unit": r["identifier"], "last4": phone[-4:]}, f"transfer:{tid}:{r['id']}", o)
    # the old owner and any co-owners lose access now; the old plan ends; the old owner's identity details are removed
    db.exec("UPDATE owner_memberships SET status = 'revoked' WHERE owner_account_id = :o", o=o)
    db.exec("UPDATE owner_allowed_numbers SET removed_at = now() WHERE owner_account_id = :o AND removed_at IS NULL", o=o)
    db.exec("UPDATE owner_subscriptions SET status = 'expired', updated_at = now() WHERE owner_account_id = :o AND status IN ('active','grace')", o=o)
    db.exec("UPDATE owner_subscriptions SET status = 'superseded', updated_at = now() WHERE owner_account_id = :o AND status = 'scheduled'", o=o)
    db.exec("""UPDATE owner_verifications SET legal_name = 'Transferred owner', address = 'Removed', pan_enc = NULL, pan_hash = NULL, pan_masked = NULL,
                 proof_ref = 'removed', status = 'rejected', updated_at = now() WHERE owner_account_id = :o""", o=o)
    db.audit(scope.user.id, o, "owner.transferred", "owner_account", o, after={"to_last4": phone[-4:]})
    if target:
        complete_transfer(db, tid, target)
    return {"status": "completed" if target else "waiting", "to": phone}
