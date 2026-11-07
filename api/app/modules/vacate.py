"""A renter asks to vacate. They cannot close a rental themselves: the request goes to the owner of THAT place only, and the rental ends
only when that owner approves. Approving uses the normal owner "end tenancy" (the place becomes vacant, notes are kept, the renter is told)."""
from __future__ import annotations

from datetime import date, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from typing import Literal

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope, tenant_tenancy
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.validation import clean_text
from . import notify
from .onboarding import EndIn, end_tenancy

router = APIRouter(prefix="/api/v1", tags=["vacate"])
COLUMNS = "v.id, v.tenancy_id, v.move_out_date, v.reason, v.status, v.owner_note, v.decided_at, v.created_at"


class RequestIn(BaseModel):
    move_out_date: date
    reason: str | None = Field(default=None, max_length=250)


@router.post("/tenancies/{tenancy_id}/vacate-request")
def request_vacate(tenancy_id: UUID, body: RequestIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    t = tenant_tenancy(db, user, tenancy_id)
    if t["status"] != "active":
        raise AppError("INVALID_STATE", "this rental has already ended")
    limiter.check(f"vacate:{user.id}", 10, 3600)
    today = date.today()
    if body.move_out_date < today or body.move_out_date > today + timedelta(days=366):
        raise AppError("VALIDATION", "choose a move-out date from today up to one year ahead", fields=[{"field": "move_out_date", "code": "out_of_range"}])
    if db.scalar("SELECT 1 FROM vacate_requests WHERE tenancy_id = :t AND status = 'requested'", t=tenancy_id):
        raise AppError("CONFLICT", "you have already asked to vacate this place; wait for the owner or take the request back", status=409)
    vid = db.scalar("""INSERT INTO vacate_requests(owner_account_id, tenancy_id, requested_by, move_out_date, reason) VALUES (:o, :t, :u, :d, :r) RETURNING id""",
                    o=t["owner_account_id"], t=tenancy_id, u=user.id, d=body.move_out_date, r=clean_text(body.reason) if body.reason else None)
    db.audit(user.id, t["owner_account_id"], "vacate.requested", "vacate_request", vid, after={"move_out_date": str(body.move_out_date)})
    name = db.scalar("SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = :t ORDER BY created_at DESC LIMIT 1", t=tenancy_id) or "Your renter"
    unit = db.scalar("SELECT identifier FROM units WHERE id = :u", u=t["unit_id"])
    # only the members of THIS tenancy's owner account are told
    for m in db.all("SELECT user_id FROM owner_memberships WHERE owner_account_id = :o AND status = 'active'", o=t["owner_account_id"]):
        notify.enqueue(db, m["user_id"], "vacate_requested", {"tenant": name, "unit": unit, "date": f"{body.move_out_date:%d-%m-%Y}"},
                       f"vacate-req:{vid}:{m['user_id']}", t["owner_account_id"])
    return dict(db.one(f"SELECT {COLUMNS} FROM vacate_requests v WHERE v.id = :i", i=vid))


@router.get("/tenancies/{tenancy_id}/vacate-request")
def latest_vacate(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    tenant_tenancy(db, user, tenancy_id)
    row = db.one(f"SELECT {COLUMNS} FROM vacate_requests v WHERE v.tenancy_id = :t ORDER BY (v.status = 'requested') DESC, v.created_at DESC LIMIT 1", t=tenancy_id)
    return {"request": dict(row) if row else None}


@router.post("/vacate-requests/{vacate_id}/cancel")
def cancel_vacate(vacate_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    v = db.one("SELECT * FROM vacate_requests WHERE id = :i AND requested_by = :u", i=vacate_id, u=user.id)
    if v is None:
        raise AppError("NOT_FOUND", "request not found")
    if v["status"] != "requested":
        raise AppError("INVALID_STATE", "this request has already been answered")
    db.exec("UPDATE vacate_requests SET status = 'cancelled', decided_at = now() WHERE id = :i", i=vacate_id)
    db.audit(user.id, v["owner_account_id"], "vacate.cancelled", "vacate_request", vacate_id)
    return {"status": "cancelled"}


@router.get("/owner/vacate-requests")
def pending_vacate(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    rows = db.all(f"""SELECT {COLUMNS}, u.identifier, p.name AS property_name, t.start_date, b.balance_paise, b.deposit_held_paise,
                             (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = v.tenancy_id ORDER BY created_at DESC LIMIT 1) AS tenant_name
                      FROM vacate_requests v JOIN tenancies t ON t.id = v.tenancy_id JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                      JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                      WHERE v.owner_account_id = :o AND v.status = 'requested' ORDER BY v.created_at DESC LIMIT 100""", o=scope.owner_account_id)
    return {"items": [dict(r) for r in rows]}


class DecideIn(BaseModel):
    action: Literal["approve", "decline"]
    end_date: date | None = None                          # approve: the last day of the rental (default: the day the renter asked for)
    deposit_note: str | None = Field(default=None, max_length=250)
    handover_note: str | None = Field(default=None, max_length=250)
    note: str | None = Field(default=None, max_length=250)    # decline: why


@router.post("/owner/vacate-requests/{vacate_id}/decide")
def decide_vacate(vacate_id: UUID, body: DecideIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    v = db.one("SELECT * FROM vacate_requests WHERE id = :i AND owner_account_id = :o", i=vacate_id, o=scope.owner_account_id)
    if v is None:
        raise AppError("NOT_FOUND", "request not found")
    if v["status"] != "requested":
        raise AppError("INVALID_STATE", "this request has already been answered")
    t = owned_tenancy(db, scope, v["tenancy_id"])
    if body.action == "decline":
        note = clean_text(body.note) if body.note else None
        db.exec("UPDATE vacate_requests SET status = 'declined', owner_note = :n, decided_by = :u, decided_at = now() WHERE id = :i", n=note, u=scope.user.id, i=vacate_id)
        db.audit(scope.user.id, scope.owner_account_id, "vacate.declined", "vacate_request", vacate_id)
        owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
        notify.enqueue(db, v["requested_by"], "vacate_declined", {"owner": owner_name, "unit": db.scalar("SELECT identifier FROM units WHERE id = :u", u=t["unit_id"])},
                       f"vacate-no:{vacate_id}", scope.owner_account_id)
        return {"status": "declined"}
    out = end_tenancy(v["tenancy_id"], body.end_date or max(v["move_out_date"], t["start_date"] + timedelta(days=1)),
                      EndIn(deposit_note=body.deposit_note, handover_note=body.handover_note), scope, db)      # ends it, tells the renter, frees the place
    db.exec("UPDATE vacate_requests SET status = 'approved', decided_by = :u, decided_at = now() WHERE id = :i", u=scope.user.id, i=vacate_id)
    db.audit(scope.user.id, scope.owner_account_id, "vacate.approved", "vacate_request", vacate_id)
    return {**out, "status": "approved"}
