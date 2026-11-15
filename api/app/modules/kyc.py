"""Identity verification (government ID + liveness selfie + name match) through a licensed provider, plus the reviewer
API for owner details and inconclusive identity checks. RentMeezy keeps only outcomes (see providers/kyc.py)."""
from __future__ import annotations

import secrets
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ..core.auth import CurrentUser, complete_user, current_user
from ..core.config import get_settings
from ..core.db import Db, get_db, transaction
from ..core.errors import AppError
from ..providers.kyc import KycResult, SandboxKyc, get_kyc_provider

router = APIRouter(prefix="/api/v1", tags=["identity-verification"])


def _out(r) -> dict:
    if r is None:
        return {"status": "none", "notice_version": get_settings().kyc_notice_version}
    return {"id": str(r["id"]), "status": r["status"], "provider": r["provider"], "method": r["method"],
            "liveness_passed": r["liveness_passed"], "face_matched": r["face_matched"], "name_matched": r["name_matched"],
            "expires_at": r["expires_at"], "review_note": r["review_note"], "notice_version": get_settings().kyc_notice_version}


def _latest(db: Db, uid: UUID):
    return db.one("""SELECT * FROM identity_verifications WHERE user_id = :u AND status <> 'withdrawn'
                     ORDER BY created_at DESC LIMIT 1""", u=uid)


def identity_verified(db: Db, uid: UUID) -> bool:
    return bool(db.scalar("""SELECT 1 FROM identity_verifications WHERE user_id = :u AND status = 'verified'
                             AND (expires_at IS NULL OR expires_at > now())""", u=uid))


def owner_fully_verified(db: Db, owner_account_id: UUID) -> bool:
    """Identity verified AND owner details approved by a reviewer — the condition for routing real rent to this owner."""
    primary = db.scalar("SELECT primary_user_id FROM owner_accounts WHERE id = :o", o=owner_account_id)
    details = db.scalar("SELECT status FROM owner_verifications WHERE owner_account_id = :o", o=owner_account_id)
    return details == "verified" and primary is not None and identity_verified(db, primary)


def apply_result(db: Db, session_id: str, res: KycResult) -> dict | None:
    """Idempotent: a finished session is never downgraded, and a replayed webhook changes nothing."""
    row = db.one("SELECT * FROM identity_verifications WHERE provider_session_id = :s FOR UPDATE", s=session_id)
    if row is None:
        return None
    if row["status"] not in ("pending", "manual_review") or res.status == "pending":
        return dict(row)
    status = res.status
    if status == "verified" and not (res.liveness_passed and res.face_matched and res.name_matched):
        status = "manual_review"                  # never auto-verify unless every check passed
    days = get_settings().kyc_validity_days
    db.exec("""UPDATE identity_verifications SET status = :st, method = :m, liveness_passed = :l, face_matched = :f, name_matched = :n,
                 expires_at = CASE WHEN :st = 'verified' THEN now() + make_interval(days => :d) END, updated_at = now()
               WHERE id = :i""", st=status, m=res.method, l=res.liveness_passed, f=res.face_matched, n=res.name_matched, d=days, i=row["id"])
    db.audit(row["user_id"], None, f"identity.{status}", "identity_verification", row["id"], after={"method": res.method})
    return dict(row, status=status)


@router.get("/me/identity")
def my_identity(user: CurrentUser = Depends(current_user), db: Db = Depends(get_db)) -> dict:
    return _out(_latest(db, user.id))


class StartIn(BaseModel):
    consent: bool
    notice_version: str
    otp_code: str | None = None          # the code sent to the account's own mobile


@router.post("/me/identity/start")
def start_identity(body: StartIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    from .action_otp import require_action_otp
    s = get_settings()
    if not body.consent or body.notice_version != s.kyc_notice_version:
        raise AppError("VALIDATION", "you must read and accept the identity verification notice",
                       fields=[{"field": "consent", "code": "required"}])
    cur = _latest(db, user.id)
    if cur and (cur["status"] in ("pending", "manual_review") or (cur["status"] == "verified" and identity_verified(db, user.id))):
        return _out(cur)                                           # idempotent
    require_action_otp(db, user.id, "identity", body.otp_code)
    provider = get_kyc_provider(s)
    name = db.scalar("SELECT full_name FROM users WHERE id = :u", u=user.id)
    sess = provider.create_session(user_id=str(user.id), full_name=name)
    rid = db.scalar("""INSERT INTO identity_verifications(user_id, provider, provider_session_id, consent_version)
                       VALUES (:u, :p, :s, :c) RETURNING id""", u=user.id, p=sess.provider, s=sess.session_id, c=body.notice_version)
    db.audit(user.id, None, "identity.started", "identity_verification", rid)
    return {**_out(db.one("SELECT * FROM identity_verifications WHERE id = :i", i=rid)), "session": sess.client}


@router.post("/me/identity/refresh")
def refresh_identity(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    cur = _latest(db, user.id)
    if cur and cur["status"] == "pending":
        apply_result(db, cur["provider_session_id"], get_kyc_provider(get_settings()).fetch_result(cur["provider_session_id"]))
        cur = _latest(db, user.id)
    return _out(cur)


@router.post("/me/identity/demo-approve")
def demo_approve(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    """Demo mode only: stands in for the human reviewer so a manual-review result can be completed locally."""
    if not get_settings().is_demo:
        raise AppError("NOT_FOUND")
    days = get_settings().kyc_validity_days
    n = db.exec("""UPDATE identity_verifications SET status = 'verified', reviewed_at = now(), review_note = 'demo reviewer', updated_at = now(),
                     expires_at = now() + make_interval(days => :d) WHERE user_id = :u AND status = 'manual_review'""", u=user.id, d=days)
    if not n:
        raise AppError("NOT_FOUND", "nothing is waiting for review")
    return _out(_latest(db, user.id))


@router.delete("/me/identity")
def withdraw_identity(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    """Withdraw consent: the stored outcome is marked withdrawn and no longer counts as verification."""
    db.exec("UPDATE identity_verifications SET status = 'withdrawn', updated_at = now() WHERE user_id = :u AND status <> 'withdrawn'", u=user.id)
    db.audit(user.id, None, "identity.withdrawn", "user", user.id)
    return {"status": "none"}


@router.post("/webhooks/kyc", include_in_schema=False)
async def kyc_webhook(request: Request) -> dict:
    body = await request.body()
    session_id, res = get_kyc_provider(get_settings()).verify_webhook(body, {k.lower(): v for k, v in request.headers.items()})
    with transaction() as db:
        apply_result(db, session_id, res)
    return {"ok": True}


# ───────────────────────── sandbox page (demo only) ─────────────────────────
@router.get("/sandbox/kyc/{session_id}", include_in_schema=False, response_class=HTMLResponse)
def sandbox_kyc_page(session_id: str) -> str:
    if not get_settings().is_demo:
        raise AppError("NOT_FOUND")
    from .sandbox_ui import option, page
    body = (
        '<div class="card"><h1>Identity verification</h1>'
        '<p class="sub">In the real app you would complete three steps with our verification partner. This demo skips them — pick the outcome you want to see.</p>'
        '<div class="steps">'
        '<div class="step"><div class="ic t">🪪</div><div>Government ID (DigiLocker / Aadhaar)</div></div>'
        '<div class="step"><div class="ic b">🤳</div><div>Live selfie with a liveness check</div></div>'
        '<div class="step"><div class="ic g">✅</div><div>Face and name matched to your profile</div></div></div></div>'
        '<form method="post" class="card"><h1 style="font-size:18px">Choose a demo result</h1>'
        + option("verified", "ok", "✅", "Verified", "All checks pass — your account shows Verified")
        + option("manual_review", "warn", "🕵️", "Needs manual review", "Some checks are unclear — a reviewer looks at it")
        + option("failed", "bad", "❌", "Failed", "The checks do not pass — you can try again")
        + '</form>')
    return page("Identity verification (demo)", body, "DEMO · no real ID or selfie is checked")


@router.post("/sandbox/kyc/{session_id}", include_in_schema=False, response_class=HTMLResponse)
async def sandbox_kyc_post(session_id: str, request: Request) -> str:
    s = get_settings()
    if not s.is_demo:
        raise AppError("NOT_FOUND")
    form = (await request.body()).decode()
    outcome = next((o for o in ("verified", "manual_review", "failed") if f"outcome={o}" in form), "failed")
    provider = get_kyc_provider(s)
    assert isinstance(provider, SandboxKyc)
    body = provider.build_event(session_id, outcome)
    sid, res = provider.verify_webhook(body, {"x-kyc-signature": provider.sign(body)})   # same path as a real webhook
    with transaction() as db:
        apply_result(db, sid, res)
    from .sandbox_ui import result
    if outcome == "verified":
        return result(True, "Identity verified", "All checks passed. Your RentMeezy account now shows Verified.")
    if outcome == "manual_review":
        return result(True, "Sent for review", "Some checks were unclear, so a reviewer will look at your result. The app shows the status.")
    return result(False, "Verification failed", "The checks did not pass. Go back to RentMeezy to see why and try again.")


# ───────────────────────── reviewer API (manual fallback) ─────────────────────────
def admin(x_admin_token: str | None = Header(default=None)) -> None:
    tok = get_settings().admin_token
    if not tok or not x_admin_token or not secrets.compare_digest(tok, x_admin_token):
        raise AppError("NOT_FOUND")                               # hidden entirely unless configured and correct


@router.get("/admin/review")
def review_queue(_: None = Depends(admin), db: Db = Depends(get_db)) -> dict:
    owners = db.all("""SELECT v.owner_account_id, v.legal_name, v.address, v.proof_type, v.proof_ref, v.declared_at,
                              v.pan_masked
                       FROM owner_verifications v WHERE v.status = 'submitted' ORDER BY v.declared_at""")
    ids = db.all("""SELECT i.id, i.user_id, u.full_name, i.liveness_passed, i.face_matched, i.name_matched, i.created_at
                    FROM identity_verifications i JOIN users u ON u.id = i.user_id WHERE i.status = 'manual_review' ORDER BY i.created_at""")
    with transaction() as sysdb:       # reviewers are not an owner: use the system connection so row-level security does not hide properties
        props = sysdb.all("""SELECT p.id, p.owner_account_id, p.name, p.address, p.city, p.pincode, p.kind, p.proof_type, p.proof_ref, p.declared_at,
                                     (p.review_flags->>'near_duplicates')::int AS near_duplicates, v.legal_name, v.status AS owner_details_status,
                                     rg_owner_write_state(p.owner_account_id) AS subscription_state
                              FROM properties p LEFT JOIN owner_verifications v ON v.owner_account_id = p.owner_account_id
                              WHERE p.verification_status = 'submitted' AND p.archived_at IS NULL ORDER BY p.declared_at""")
        props = [dict(r) for r in props]
    return {"owner_details": [dict(r) for r in owners], "identity": [dict(r) for r in ids], "properties": props}


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str | None = None


@router.post("/admin/review/owner/{owner_account_id}")
def review_owner(owner_account_id: UUID, body: DecisionIn, _: None = Depends(admin), db: Db = Depends(get_db)) -> dict:
    n = db.exec("""UPDATE owner_verifications SET status = :s, reviewed_at = now(), review_note = :n, updated_at = now()
                   WHERE owner_account_id = :o AND status = 'submitted'""",
                s="verified" if body.decision == "approve" else "rejected", n=body.note, o=owner_account_id)
    if not n:
        raise AppError("NOT_FOUND", "nothing to review")
    db.exec("""UPDATE owner_verifications SET status = :s, reviewed_at = now(), review_note = :n, updated_at = now()
               WHERE copied_from_account = :o""", s="verified" if body.decision == "approve" else "rejected", n=body.note, o=owner_account_id)
    db.audit(None, owner_account_id, f"owner.details_{body.decision}d", "owner_account", owner_account_id)
    return {"status": "verified" if body.decision == "approve" else "rejected"}


@router.post("/admin/review/property/{property_id}")
def review_property(property_id: UUID, body: DecisionIn, _: None = Depends(admin)) -> dict:
    """Verify (or reject) a property's ownership proof. Rejecting frees the address and proof number again. Only here, through the
    system connection, can a property become verified."""
    with transaction() as sysdb:
        p = sysdb.one("SELECT id, owner_account_id, verification_status FROM properties WHERE id = :p AND archived_at IS NULL FOR UPDATE", p=property_id)
        if p is None or p["verification_status"] != "submitted":
            raise AppError("NOT_FOUND", "nothing to review")
        if body.decision == "approve" and sysdb.scalar("SELECT rg_owner_write_state(:o)", o=p["owner_account_id"]) not in ("active", "grace"):
            raise AppError("SUBSCRIPTION_REQUIRED", "the owner has no active plan for this property yet")
        status = "verified" if body.decision == "approve" else "rejected"
        sysdb.exec("UPDATE properties SET verification_status = :s, reviewed_at = now(), review_note = :n WHERE id = :p", s=status, n=body.note, p=property_id)
        sysdb.audit(None, p["owner_account_id"], f"property.{status}", "property", property_id, after={"note": body.note})
    return {"status": status}


@router.post("/admin/review/identity/{identity_id}")
def review_identity(identity_id: UUID, body: DecisionIn, _: None = Depends(admin), db: Db = Depends(get_db)) -> dict:
    days = get_settings().kyc_validity_days
    n = db.exec("""UPDATE identity_verifications SET status = :s, reviewed_at = now(), review_note = :n, updated_at = now(),
                     expires_at = CASE WHEN :s = 'verified' THEN now() + make_interval(days => :d) END
                   WHERE id = :i AND status = 'manual_review'""",
                s="verified" if body.decision == "approve" else "rejected", n=body.note, d=days, i=identity_id)
    if not n:
        raise AppError("NOT_FOUND", "nothing to review")
    return {"status": "verified" if body.decision == "approve" else "rejected"}
