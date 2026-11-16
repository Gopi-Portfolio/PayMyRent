"""A renter writes to the owner of a rental they have accepted (typed, or spoken and turned into text on the phone).
It reaches the owner's bell with a Reply button that opens the owner's message screen for that rental."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Header
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, complete_user, tenant_tenancy
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.idempotency import fingerprint, idempotent
from ..core.http import limiter
from ..domain.validation import clean_text, grapheme_count
from . import notify

router = APIRouter(prefix="/api/v1/tenant", tags=["messages"])
MAX_CHARS = 500


class RenterMessageIn(BaseModel):
    text: str = Field(max_length=700)
    lang: Literal["en", "ta", "hi", "te", "kn", "ml", "mr", "bn"] = "en"       # the language it was written in
    input_method: Literal["typed", "voice"] = "typed"


@router.post("/tenancies/{tenancy_id}/messages")
def send_to_owner(tenancy_id: UUID, body: RenterMessageIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")) -> dict:
    def work() -> dict:
        t = tenant_tenancy(db, user, tenancy_id)
        if t["status"] != "active":
            raise AppError("INVALID_STATE", "this rental has ended")
        limiter.check(f"renter-msg:{user.id}", 20, 3600)
        text = clean_text(body.text)
        if not 1 <= grapheme_count(text) <= MAX_CHARS:
            raise AppError("VALIDATION", f"the message must be 1 to {MAX_CHARS} characters", fields=[{"field": "text", "code": "too_long"}])
        if db.one("SELECT id FROM renter_messages WHERE tenancy_id = :t AND sent_by = :u AND text = :x AND created_at > now() - interval '10 seconds'",
                  t=tenancy_id, u=user.id, x=text):
            return {"status": "already_sent"}                                    # a double tap: not sent twice
        mid = db.scalar("""INSERT INTO renter_messages(owner_account_id, tenancy_id, sent_by, text, lang, input_method)
                           VALUES (:o, :t, :u, :x, :l, :m) RETURNING id""", o=t["owner_account_id"], t=tenancy_id, u=user.id, x=text, l=body.lang, m=body.input_method)
        name = db.scalar("SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = :t ORDER BY created_at DESC LIMIT 1", t=tenancy_id) or db.scalar("SELECT full_name FROM users WHERE id = :u", u=user.id) or ""
        unit = db.scalar("SELECT identifier FROM units WHERE id = :u", u=t["unit_id"])
        owners = [r["user_id"] for r in db.all("SELECT user_id FROM owner_memberships WHERE owner_account_id = :o AND status = 'active'", o=t["owner_account_id"])]
        for uid in owners:                                                       # every owner of the account sees it in their bell
            notify.enqueue(db, uid, "renter_message", {"body": f"{name} ({unit}): {text}", "message_id": str(mid), "tenancy_id": str(tenancy_id)},
                           f"renter-msg:{mid}:{uid}", t["owner_account_id"], channels=("push",))
        db.audit(user.id, t["owner_account_id"], "message.renter_sent", "tenancy", tenancy_id, after={"message_id": str(mid), "lang": body.lang, "input": body.input_method})
        return {"status": "sent", "id": str(mid)}
    return idempotent(db, user.id, idempotency_key, fingerprint("POST", f"/tenant/tenancies/{tenancy_id}/messages", body.model_dump(mode="json")), work)


@router.get("/tenancies/{tenancy_id}/messages")
def my_sent_messages(tenancy_id: UUID, limit: int = Query(default=10, ge=1, le=50), user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    tenant_tenancy(db, user, tenancy_id)
    rows = db.all("SELECT id, text, lang, input_method, created_at FROM renter_messages WHERE tenancy_id = :t AND sent_by = :u ORDER BY created_at DESC LIMIT :n",
                  t=tenancy_id, u=user.id, n=limit)
    return {"items": [dict(r, id=str(r["id"])) for r in rows]}
