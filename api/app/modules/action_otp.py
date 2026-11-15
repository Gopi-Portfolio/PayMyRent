"""A one-time code approves every verification step.

Identity check, owner details, property, payout account and a second-owner number each need a fresh 6-digit code that was sent to the
mobile number attached to the signed-in account (its verified primary number) and to nobody else. The code is for ONE step only
(a code for 'property' cannot approve 'payout'), is single-use, expires, and wrong guesses are limited. Without it the step is refused.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..core.auth import CurrentUser, current_user
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.signatures import mask_phone
from . import notify
from .identity import _check_otp, _issue_otp

router = APIRouter(prefix="/api/v1", tags=["verification-otp"])
Action = Literal["identity", "owner_details", "property", "payout", "co_owner", "transfer"]


def _primary_phone(db: Db, user_id: UUID) -> str:
    phone = db.scalar("""SELECT value FROM user_contacts WHERE user_id = :u AND kind = 'mobile' AND is_primary
                         AND verified_at IS NOT NULL AND removed_at IS NULL""", u=user_id)
    if not phone:
        raise AppError("FORBIDDEN", "verify your mobile number first")
    return phone


def _target(phone: str, action: str) -> str:
    return f"{phone}|{action}"                 # the code is bound to this number AND this one step


class ActionOtpIn(BaseModel):
    action: Action


@router.post("/me/action-otp/request")
def request_action_otp(body: ActionOtpIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db)) -> dict:
    """Send a code to the number attached to this account. The destination is never taken from the request."""
    from ..core.config import get_settings
    s = get_settings()
    limiter.check(f"actotp-send:{user.id}:{body.action}", 20 if s.is_demo else 3, 600)
    phone = _primary_phone(db, user.id)
    code = _issue_otp(db, _target(phone, body.action), "verify_action", user.id)
    lang = db.scalar("SELECT preferred_language FROM users WHERE id = :u", u=user.id) or "en"
    notify.send_otp(db, "mobile", phone, code, lang)
    db.audit(user.id, None, "action_otp.sent", "user", user.id, after={"action": body.action})
    out = {"sent_to": mask_phone(phone), "expires_in": s.otp_ttl_seconds}
    if s.is_demo:
        out["demo_code"] = code
        out["demo_notice"] = "Demo mode: no SMS was sent."
    return out


def require_action_otp(db: Db, user_id: UUID, action: str, code: str | None) -> None:
    """Call first in every verification step. Raises unless `code` is the live code sent to this account's own mobile for `action`.
    Does nothing while RG_ACTION_CODES_REQUIRED is false: then the login code is the only one."""
    from ..core.config import get_settings
    if not get_settings().action_codes_required:
        return
    if not code or not code.strip():
        raise AppError("FORBIDDEN", "enter the code sent to your registered mobile number", otp_required=True, action=action)
    limiter.check(f"actotp-try:{user_id}:{action}", 10, 600)     # counted outside the request, so failed tries cannot be undone
    phone = _primary_phone(db, user_id)
    _check_otp(db, _target(phone, action), "verify_action", code)
    db.audit(user_id, None, "action_otp.used", "user", user_id, after={"action": action})
