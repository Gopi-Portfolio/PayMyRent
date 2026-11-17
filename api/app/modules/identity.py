"""Identity, registration, role intent, profile, contacts, notification preferences and the
secure Change-Primary-Mobile flow."""
from __future__ import annotations

import secrets
import time
from datetime import time as dtime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, Identity, current_user, identity_dep, issue_dev_token, verify_token
from ..core.config import get_settings
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.idempotency import fingerprint, idempotent
from ..core.http import limiter
from ..domain.signatures import hash_otp, mask_phone
from ..domain.validation import (
    normalize_email, normalize_indian_mobile, validate_address, validate_full_name, validate_language,
)
from . import notify

router = APIRouter(prefix="/api/v1", tags=["identity"])
STEP_UP_SECONDS = 300


# ───────────────────────── OTP service (dev login + secondary contact verification) ─────────────────────────
def _issue_otp(db: Db, target: str, purpose: str, user_id: UUID | None) -> str:
    s = get_settings()
    recent = db.scalar("SELECT count(*) FROM otp_challenges WHERE target = :t AND created_at > now() - interval '1 hour'", t=target)
    if recent >= (500 if s.is_demo else s.otp_max_per_hour):   # demo: many test phones share one Mac
        raise AppError("RATE_LIMITED", "too many codes requested; try again later")
    code = "123456" if s.is_demo else f"{secrets.randbelow(1_000_000):06d}"
    db.exec("""INSERT INTO otp_challenges(target, purpose, user_id, code_hash, expires_at)
               VALUES (:t, :p, :u, :h, now() + make_interval(secs => :ttl))""",
            t=target, p=purpose, u=user_id, h=hash_otp(s.otp_hash_secret, target, code), ttl=s.otp_ttl_seconds)
    return code


def _check_otp(db: Db, target: str, purpose: str, code: str) -> None:
    s = get_settings()
    ch = db.one("""SELECT id, code_hash, attempts FROM otp_challenges
                   WHERE target = :t AND purpose = :p AND consumed_at IS NULL AND expires_at > now()
                   ORDER BY created_at DESC LIMIT 1 FOR UPDATE""", t=target, p=purpose)
    if ch is None or ch["attempts"] >= s.otp_max_attempts:
        raise AppError("VALIDATION", "code expired or too many attempts; request a new one")
    if not secrets.compare_digest(ch["code_hash"], hash_otp(s.otp_hash_secret, target, code.strip())):
        db.exec("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = :i", i=ch["id"])
        raise AppError("VALIDATION", "incorrect code")
    db.exec("UPDATE otp_challenges SET consumed_at = now() WHERE id = :i", i=ch["id"])


class PhoneIn(BaseModel):
    phone: str = Field(max_length=20)


class SignInIntent(BaseModel):
    """What the person chose on the landing page before signing in: the door (owner / renter) and, for a new owner, the plan."""
    role: Literal["owner", "tenant"] | None = None
    plan: str | None = Field(default=None, max_length=40)


class OtpVerifyIn(PhoneIn, SignInIntent):
    code: str = Field(min_length=4, max_length=8)


def _require_plan_for_new_owner(db: Db, phone: str, intent: SignInIntent) -> None:
    """A first-time owner must have chosen a plan before signing in: a number nobody has used yet, coming through the owner door
    without a plan, gets no sign-in token and no account. An owner who already has an account signs in as before."""
    if intent.role != "owner" or intent.plan:
        return
    known = db.scalar("""SELECT 1 FROM user_contacts WHERE kind = 'mobile' AND value = :p AND verified_at IS NOT NULL
                         AND removed_at IS NULL LIMIT 1""", p=phone)
    if not known:
        raise AppError("PLAN_REQUIRED", "choose a plan first, then sign in as a new owner", status=403)


@router.post("/dev/otp/request", tags=["dev"])
def dev_otp_request(body: PhoneIn, db: Db = Depends(get_db, scope="function")) -> dict:
    """LOCAL DEMO ONLY. Production login OTP is sent and verified by Firebase Phone Auth."""
    s = get_settings()
    if not s.dev_auth_enabled or s.app_env == "production":
        raise AppError("NOT_FOUND")
    phone = normalize_indian_mobile(body.phone, "phone")
    limiter.check(f"otp:{phone}", 60 if get_settings().is_demo else 3, 60)
    code = _issue_otp(db, phone, "dev_login", None)
    return {"sent_to": mask_phone(phone), "demo_code": code, "demo_notice": "Demo mode: no SMS was sent."}


@router.post("/dev/otp/verify", tags=["dev"])
def dev_otp_verify(body: OtpVerifyIn, db: Db = Depends(get_db, scope="function"), authorization: str | None = Header(default=None)) -> dict:
    s = get_settings()
    if not s.dev_auth_enabled or s.app_env == "production":
        raise AppError("NOT_FOUND")
    phone = normalize_indian_mobile(body.phone, "phone")
    _check_otp(db, phone, "dev_login", body.code)
    _require_plan_for_new_owner(db, phone, body)          # (after the code, so it cannot be used to find out which numbers are registered)
    # Mirrors Firebase: the same number signs into the same uid; a signed-in user who verifies a
    # new number (change-mobile flow) keeps their uid.
    uid = None
    if authorization:
        uid = verify_token(authorization).firebase_uid
    if uid is None:
        uid = db.scalar("""SELECT u.firebase_uid FROM users u JOIN user_contacts c ON c.user_id = u.id
                           WHERE c.kind = 'mobile' AND c.is_primary AND c.value = :p AND c.removed_at IS NULL""", p=phone)
    return {"id_token": issue_dev_token(phone, uid), "demo": True}


# ───────────────────────── session / me ─────────────────────────
@router.post("/auth/session")
def create_session(body: SignInIntent | None = None, identity: Identity = Depends(identity_dep), db: Db = Depends(get_db, scope="function")) -> dict:
    """Called after OTP sign-in. Existing user → same account; new number → new account."""
    if not identity.phone:
        raise AppError("UNAUTHENTICATED", "phone-verified token required")
    phone = normalize_indian_mobile(identity.phone, "phone")
    uid = db.scalar("SELECT id FROM users WHERE firebase_uid = :f", f=identity.firebase_uid)
    if uid is None:
        if body is not None:
            _require_plan_for_new_owner(db, phone, body)      # no account is created for a first-time owner without a plan
        other = db.scalar("""SELECT user_id FROM user_contacts WHERE kind = 'mobile' AND value = :p
                             AND verified_at IS NOT NULL AND removed_at IS NULL""", p=phone)
        if other is not None:
            # The number is verified on an existing account (e.g. as its secondary mobile).
            # Never merge or hand over an account automatically.
            raise AppError("PHONE_IN_USE", "this number is linked to another account; sign in with that account's primary number")
        uid = db.scalar("INSERT INTO users(firebase_uid) VALUES (:f) RETURNING id", f=identity.firebase_uid)
        cid = db.scalar("""INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at)
                           VALUES (:u, 'mobile', :p, true, now()) RETURNING id""", u=uid, p=phone)
        db.exec("""INSERT INTO notification_preferences(user_id, sms_contact_id, whatsapp_contact_id)
                   VALUES (:u, :c, :c)""", u=uid, c=cid)
        db.exec("INSERT INTO consent_records(user_id, channel, granted, source) VALUES (:u, 'sms', true, 'signup_transactional')", u=uid)
        db.audit(uid, None, "user.registered", "user", uid)
    return me_payload(db, uid)


def me_payload(db: Db, uid: UUID) -> dict:
    from .owner_numbers import claim_owner_memberships
    from .transfer import claim_transfers
    claim_transfers(db, uid)             # an owner account handed to this number becomes theirs
    claim_owner_memberships(db, uid)      # a declared owner number joins its account the moment that person signs in
    u = db.must("SELECT * FROM users WHERE id = :u", u=uid)
    roles = [r["role"] for r in db.all("SELECT role FROM user_roles WHERE user_id = :u ORDER BY role", u=uid)]
    contacts = db.all("""SELECT id, kind, value, is_primary, for_mobile_id, verified_at IS NOT NULL AS verified FROM user_contacts
                         WHERE user_id = :u AND removed_at IS NULL ORDER BY kind, is_primary DESC, created_at""", u=uid)
    prefs = db.one("SELECT * FROM notification_preferences WHERE user_id = :u", u=uid)
    owners = db.all("""SELECT m.owner_account_id, m.role, rg_owner_write_state(m.owner_account_id) AS state,
                              (SELECT v.status FROM owner_verifications v WHERE v.owner_account_id = m.owner_account_id) AS verification,
                              (SELECT p.name FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1) AS property_name,
                              (SELECT p.address FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1) AS property_address,
                              (SELECT p.verification_status FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1) AS property_status,
                              (SELECT p.kind FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 1) AS property_kind,
                              (SELECT count(*) FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL AND p.verification_status <> 'rejected') AS property_count,
                              GREATEST(rg_property_allowance(m.owner_account_id), (SELECT count(*) FROM properties p WHERE p.owner_account_id = m.owner_account_id AND p.archived_at IS NULL)) AS property_capacity
                       FROM owner_memberships m WHERE m.user_id = :u AND m.status = 'active' ORDER BY m.created_at""", u=uid)
    invites = db.scalar("""SELECT count(*) FROM tenancy_invitations i JOIN user_contacts c
                           ON c.value = i.phone AND c.kind = 'mobile' AND c.verified_at IS NOT NULL AND c.removed_at IS NULL
                           WHERE c.user_id = :u AND i.status = 'pending'""", u=uid)
    return {
        "id": str(u["id"]), "full_name": u["full_name"], "address": u["address"], "preferred_language": u["preferred_language"],
        "profile_complete": u["profile_completed_at"] is not None, "version": u["version"], "roles": roles,
        "contacts": [dict(c) for c in contacts],
        "notification_preferences": dict(prefs) if prefs else None,
        "owner_accounts": [dict(o) for o in owners],
        "pending_invitations": invites,
        "action_codes_required": get_settings().action_codes_required,     # false: the app never shows the extra code boxes
        "identity_status": db.scalar("""SELECT status FROM identity_verifications WHERE user_id = :u AND status <> 'withdrawn'
                                        ORDER BY created_at DESC LIMIT 1""", u=uid) or "none",
    }


@router.get("/me")
def get_me(user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    return me_payload(db, user.id)


class RolesIn(BaseModel):
    roles: list[Literal["owner", "tenant"]] = Field(min_length=1, max_length=2)


@router.post("/me/roles")
def set_roles(body: RolesIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """Role *intent*. Adding 'owner' creates the owner account (unpaid until a plan is
    activated). Roles are additive; nothing here grants access to anyone else's data."""
    for role in set(body.roles):
        db.exec("INSERT INTO user_roles(user_id, role) VALUES (:u, :r) ON CONFLICT DO NOTHING", u=user.id, r=role)
        if role == "owner":
            oid = db.scalar("SELECT id FROM owner_accounts WHERE primary_user_id = :u ORDER BY created_at LIMIT 1", u=user.id)
            if oid is None:
                name = db.scalar("SELECT COALESCE(full_name, 'Owner') FROM users WHERE id = :u", u=user.id)
                oid = db.scalar("INSERT INTO owner_accounts(primary_user_id, display_name) VALUES (:u, :n) RETURNING id", u=user.id, n=name)
                db.exec("INSERT INTO owner_memberships(owner_account_id, user_id, role) VALUES (:o, :u, 'owner')", o=oid, u=user.id)
                db.exec("INSERT INTO reminder_rules(owner_account_id) VALUES (:o) ON CONFLICT DO NOTHING", o=oid)
    db.audit(user.id, None, "user.roles_set", "user", user.id, after={"roles": body.roles})
    return me_payload(db, user.id)


class ProfileIn(BaseModel):
    full_name: str = Field(max_length=400)
    address: str | None = Field(default=None, max_length=1000)
    preferred_language: str = "en"
    version: int


@router.put("/me/profile")
def update_profile(body: ProfileIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function"), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> dict:
    def work() -> dict:
        name = validate_full_name(body.full_name)
        address = validate_address(body.address, required=False)
        lang = validate_language(body.preferred_language)
        before = db.one("SELECT full_name, address, preferred_language FROM users WHERE id = :u", u=user.id)
        n = db.exec("""UPDATE users SET full_name = :n, address = :a, preferred_language = :l, version = version + 1,
                       profile_completed_at = COALESCE(profile_completed_at, now())
                       WHERE id = :u AND version = :v""", n=name, a=address, l=lang, u=user.id, v=body.version)
        if n == 0:
            raise AppError("STALE_VERSION", "profile changed elsewhere; reload and try again")
        db.exec("UPDATE owner_accounts SET display_name = :n WHERE primary_user_id = :u", n=name, u=user.id)
        db.audit(user.id, None, "user.profile_updated", "user", user.id, before=dict(before),
                 after={"full_name": name, "address": address, "preferred_language": lang})
        return me_payload(db, user.id)
    return idempotent(db, user.id, idempotency_key, fingerprint("PUT", "/me/profile", body.model_dump(mode="json")), work)


class ContactIn(BaseModel):
    kind: Literal["mobile", "email"]
    value: str = Field(max_length=254)
    for_mobile_id: UUID | None = None      # an email must say which of the person's OWN mobile numbers it belongs to


@router.post("/me/contacts")
def add_contact(body: ContactIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    value = normalize_indian_mobile(body.value) if body.kind == "mobile" else normalize_email(body.value)
    if db.scalar("""SELECT 1 FROM user_contacts WHERE kind = 'mobile' AND value = :v AND verified_at IS NOT NULL
                    AND removed_at IS NULL""", v=value):
        raise AppError("PHONE_IN_USE", "this number is already verified on an account")
    has_primary = db.scalar("SELECT 1 FROM user_contacts WHERE user_id = :u AND kind = :k AND is_primary AND removed_at IS NULL",
                            u=user.id, k=body.kind)
    if body.kind == "email":
        if body.for_mobile_id is None:
            raise AppError("VALIDATION", "choose which mobile number this email belongs to", fields=[{"field": "for_mobile_id", "code": "required"}])
        if not db.scalar("SELECT 1 FROM user_contacts WHERE id = :m AND user_id = :u AND kind = 'mobile' AND removed_at IS NULL", m=body.for_mobile_id, u=user.id):
            raise AppError("VALIDATION", "that is not one of your mobile numbers", fields=[{"field": "for_mobile_id", "code": "invalid"}])
        if db.scalar("SELECT 1 FROM user_contacts WHERE kind = 'email' AND for_mobile_id = :m AND removed_at IS NULL", m=body.for_mobile_id):
            raise AppError("CONFLICT", "this mobile number already has an email. Remove it first to add another.", status=409)
    cid = db.scalar("""INSERT INTO user_contacts(user_id, kind, value, is_primary, for_mobile_id) VALUES (:u, :k, :v, :p, :f) RETURNING id""",
                    u=user.id, k=body.kind, v=value, p=not has_primary and body.kind == "email", f=body.for_mobile_id if body.kind == "email" else None)
    code = _issue_otp(db, value, "verify_mobile" if body.kind == "mobile" else "verify_email", user.id)
    notify.send_otp(db, body.kind, value, code, user.language)
    out = {"contact_id": str(cid), "verification_sent": True}
    if get_settings().is_demo:
        out["demo_code"] = code
    return out


class CodeIn(BaseModel):
    code: str = Field(min_length=4, max_length=8)


@router.post("/me/contacts/{contact_id}/verify")
def verify_contact(contact_id: UUID, body: CodeIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    c = db.must("SELECT * FROM user_contacts WHERE id = :c AND user_id = :u AND removed_at IS NULL", "contact", c=contact_id, u=user.id)
    _check_otp(db, c["value"], "verify_mobile" if c["kind"] == "mobile" else "verify_email", body.code)
    db.exec("UPDATE user_contacts SET verified_at = now() WHERE id = :c", c=contact_id)
    if c["kind"] == "email":
        db.exec("UPDATE notification_preferences SET email_contact_id = COALESCE(email_contact_id, :c) WHERE user_id = :u", c=contact_id, u=user.id)
    db.audit(user.id, None, "contact.verified", "user_contact", contact_id)
    return me_payload(db, user.id)


@router.delete("/me/contacts/{contact_id}")
def remove_contact(contact_id: UUID, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    c = db.must("SELECT * FROM user_contacts WHERE id = :c AND user_id = :u AND removed_at IS NULL", "contact", c=contact_id, u=user.id)
    if c["kind"] == "mobile" and c["is_primary"]:
        raise AppError("VALIDATION", "use Change Primary Mobile to replace the login number")
    db.exec("UPDATE user_contacts SET removed_at = now(), is_primary = false WHERE id = :c", c=contact_id)
    if c["kind"] == "mobile":      # the email that belonged to this number goes with it
        gone = [r["id"] for r in db.all("SELECT id FROM user_contacts WHERE kind = 'email' AND for_mobile_id = :c AND removed_at IS NULL", c=contact_id)]
        for eid in gone:
            db.exec("UPDATE user_contacts SET removed_at = now(), is_primary = false WHERE id = :e", e=eid)
            db.exec("UPDATE notification_preferences SET email_contact_id = NULL WHERE user_id = :u AND email_contact_id = :e", u=user.id, e=eid)
    prim = db.scalar("SELECT id FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND is_primary AND removed_at IS NULL", u=user.id)
    db.exec("""UPDATE notification_preferences SET
                 sms_contact_id = CASE WHEN sms_contact_id = :c THEN :p ELSE sms_contact_id END,
                 whatsapp_contact_id = CASE WHEN whatsapp_contact_id = :c THEN :p ELSE whatsapp_contact_id END,
                 email_contact_id = CASE WHEN email_contact_id = :c THEN NULL ELSE email_contact_id END
               WHERE user_id = :u""", c=contact_id, p=prim, u=user.id)
    db.audit(user.id, None, "contact.removed", "user_contact", contact_id)
    return me_payload(db, user.id)


class PrefsIn(BaseModel):
    sms_contact_id: UUID | None = None
    whatsapp_contact_id: UUID | None = None
    email_contact_id: UUID | None = None
    sms_enabled: bool = True
    whatsapp_enabled: bool = False
    email_enabled: bool = True
    push_enabled: bool = True
    quiet_start: dtime = dtime(21, 0)
    quiet_end: dtime = dtime(8, 0)


@router.put("/me/notification-preferences")
def set_preferences(body: PrefsIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    for field, kind in (("sms_contact_id", "mobile"), ("whatsapp_contact_id", "mobile"), ("email_contact_id", "email")):
        cid = getattr(body, field)
        if cid and not db.scalar("""SELECT 1 FROM user_contacts WHERE id = :c AND user_id = :u AND kind = :k
                                    AND verified_at IS NOT NULL AND removed_at IS NULL""", c=cid, u=user.id, k=kind):
            raise AppError("VALIDATION", f"{field} must be one of your verified {kind} contacts")
    old = db.one("SELECT * FROM notification_preferences WHERE user_id = :u", u=user.id)
    db.exec("""INSERT INTO notification_preferences(user_id, sms_contact_id, whatsapp_contact_id, email_contact_id, sms_enabled,
                 whatsapp_enabled, email_enabled, push_enabled, quiet_start, quiet_end, updated_at)
               VALUES (:u, :s, :w, :e, :se, :we, :ee, :pe, :qs, :qe, now())
               ON CONFLICT (user_id) DO UPDATE SET sms_contact_id = EXCLUDED.sms_contact_id,
                 whatsapp_contact_id = EXCLUDED.whatsapp_contact_id, email_contact_id = EXCLUDED.email_contact_id,
                 sms_enabled = EXCLUDED.sms_enabled, whatsapp_enabled = EXCLUDED.whatsapp_enabled,
                 email_enabled = EXCLUDED.email_enabled, push_enabled = EXCLUDED.push_enabled,
                 quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, updated_at = now()""",
            u=user.id, s=body.sms_contact_id, w=body.whatsapp_contact_id, e=body.email_contact_id, se=body.sms_enabled,
            we=body.whatsapp_enabled, ee=body.email_enabled, pe=body.push_enabled, qs=body.quiet_start, qe=body.quiet_end)
    # Consent is recorded as an append-only event whenever an opt-in flag changes.
    for ch, flag in (("sms", body.sms_enabled), ("whatsapp", body.whatsapp_enabled), ("email", body.email_enabled), ("push", body.push_enabled)):
        if old is None or old[f"{ch}_enabled"] != flag:
            db.exec("INSERT INTO consent_records(user_id, channel, granted, source) VALUES (:u, :c, :g, 'profile_settings')",
                    u=user.id, c=ch, g=flag)
    return me_payload(db, user.id)


# ───────────────────────── Change primary mobile ─────────────────────────
class MobileChangeStartIn(BaseModel):
    new_phone: str


@router.post("/me/mobile-change/start")
def mobile_change_start(body: MobileChangeStartIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """Step 1 — prove possession of the CURRENT number: the token must have been minted by a fresh
    OTP sign-in on the current primary number within the last 5 minutes (step-up)."""
    new = normalize_indian_mobile(body.new_phone, "new_phone")
    old = db.scalar("SELECT value FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND is_primary AND removed_at IS NULL", u=user.id)
    if user.identity.phone != old or time.time() - user.identity.issued_at > STEP_UP_SECONDS:
        raise AppError("FORBIDDEN", "re-verify your current number first", step_up_required=True)
    if new == old:
        raise AppError("VALIDATION", "that is already your primary number")
    if db.scalar("""SELECT 1 FROM user_contacts WHERE kind = 'mobile' AND value = :v AND verified_at IS NOT NULL
                    AND removed_at IS NULL AND user_id <> :u""", v=new, u=user.id):
        raise AppError("PHONE_IN_USE", "this number belongs to another account")
    db.exec("UPDATE mobile_change_requests SET status = 'expired' WHERE user_id = :u AND status = 'pending'", u=user.id)
    rid = db.scalar("""INSERT INTO mobile_change_requests(user_id, old_phone, new_phone, method, old_verified_at)
                       VALUES (:u, :o, :n, 'old_and_new_otp', now()) RETURNING id""", u=user.id, o=old, n=new)
    db.audit(user.id, None, "mobile_change.started", "user", user.id, after={"new": mask_phone(new)})
    return {"request_id": str(rid), "next": "verify_new_number_with_firebase_then_complete"}


class MobileChangeCompleteIn(BaseModel):
    request_id: UUID


@router.post("/me/mobile-change/complete")
def mobile_change_complete(body: MobileChangeCompleteIn, identity: Identity = Depends(identity_dep), db: Db = Depends(get_db, scope="function")) -> dict:
    """Step 2 — the client has linked the new number to the SAME Firebase user
    (updatePhoneNumber with an OTP credential), so the fresh token carries the new number.
    The internal UUID — and with it every property, tenancy, payment, deposit, note and the
    owner subscription — is untouched; only the contact rows change."""
    uid = db.scalar("SELECT id FROM users WHERE firebase_uid = :f", f=identity.firebase_uid)
    req = db.one("""SELECT * FROM mobile_change_requests WHERE id = :r AND user_id = :u AND status = 'pending'
                    AND created_at > now() - interval '30 minutes' FOR UPDATE""", r=body.request_id, u=uid)
    if req is None:
        raise AppError("NOT_FOUND", "change request not found or expired")
    if identity.phone != req["new_phone"] or time.time() - identity.issued_at > STEP_UP_SECONDS:
        raise AppError("FORBIDDEN", "verify the new number first", step_up_required=True)
    old_cid = db.scalar("SELECT id FROM user_contacts WHERE user_id = :u AND kind='mobile' AND is_primary AND removed_at IS NULL", u=uid)
    db.exec("UPDATE user_contacts SET removed_at = now(), is_primary = false WHERE id = :c", c=old_cid)
    existing = db.scalar("SELECT id FROM user_contacts WHERE user_id = :u AND kind='mobile' AND value = :v AND removed_at IS NULL",
                         u=uid, v=req["new_phone"])
    if existing:
        new_cid = existing
        db.exec("UPDATE user_contacts SET is_primary = true, verified_at = COALESCE(verified_at, now()) WHERE id = :c", c=existing)
    else:
        new_cid = db.scalar("""INSERT INTO user_contacts(user_id, kind, value, is_primary, verified_at)
                               VALUES (:u, 'mobile', :v, true, now()) RETURNING id""", u=uid, v=req["new_phone"])
    db.exec("UPDATE user_contacts SET for_mobile_id = :n WHERE user_id = :u AND kind = 'email' AND for_mobile_id = :o AND removed_at IS NULL", n=new_cid, o=old_cid, u=uid)
    db.exec("""UPDATE notification_preferences SET
                 sms_contact_id = CASE WHEN sms_contact_id = :o OR sms_contact_id IS NULL THEN :n ELSE sms_contact_id END,
                 whatsapp_contact_id = CASE WHEN whatsapp_contact_id = :o THEN :n ELSE whatsapp_contact_id END
               WHERE user_id = :u""", o=old_cid, n=new_cid, u=uid)
    db.exec("UPDATE mobile_change_requests SET status = 'completed', new_verified_at = now(), completed_at = now() WHERE id = :r", r=req["id"])
    # Revoke every other session (the caller refreshes its token).
    db.exec("UPDATE users SET sessions_valid_after = now(), version = version + 1 WHERE id = :u", u=uid)
    db.audit(uid, None, "mobile_change.completed", "user", uid, before={"phone": mask_phone(req["old_phone"])},
             after={"phone": mask_phone(req["new_phone"])})
    notify.security_event(db, uid, req["old_phone"], "primary_mobile_changed")
    return {"status": "completed", "refresh_token_required": True}


class RecoveryIn(BaseModel):
    old_phone: str
    reason: str = Field(min_length=10, max_length=500)


@router.post("/me/mobile-change/recovery")
def mobile_change_recovery(body: RecoveryIn, identity: Identity = Depends(identity_dep), db: Db = Depends(get_db, scope="function")) -> dict:
    """Old phone lost: the person signs in with the NEW number and files a request naming the old
    number. Support reviews it manually (identity documents, owner/tenant confirmation) and
    completes it through the admin tool. Nothing is moved automatically, an owner can never
    move another person's account, and the response is identical whether or not the old
    number exists (no account enumeration)."""
    if not identity.phone:
        raise AppError("UNAUTHENTICATED", "phone-verified token required")
    new = normalize_indian_mobile(identity.phone, "phone")
    old = normalize_indian_mobile(body.old_phone, "old_phone")
    limiter.check(f"recovery:{new}", 2, 86400)
    db.exec("""INSERT INTO mobile_change_requests(user_id, old_phone, new_phone, method, status, reviewer_note)
               SELECT c.user_id, c.value, :n, 'manual_review', 'under_review', :r FROM user_contacts c
               WHERE c.kind = 'mobile' AND c.is_primary AND c.removed_at IS NULL AND c.value = :o""",
            n=new, r=body.reason, o=old)
    return {"status": "under_review", "message": "If that number has an account, our support team will contact you to verify your identity."}
