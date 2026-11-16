"""Rent relief. A renter who cannot pay the whole month asks the owner; the owner agrees what must be paid now and the rest moves
to next month (or the owner grants it without being asked). The bill shows the full month and the agreed part; the total owed never
changes. The money movement is done by rg_apply_rent_relief (a credit note this month + a carried-over charge next month)."""
from __future__ import annotations

from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope, tenant_tenancy, tenancy_party
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.money import format_inr, parse_inr
from ..domain.validation import clean_text
from . import notify

router = APIRouter(prefix="/api/v1", tags=["rent-relief"])

COLUMNS = """r.id, r.tenancy_id, r.period_month, r.initiated_by, r.status, r.requested_pay_paise, r.reason, r.billed_paise, r.open_paise,
             r.agreed_pay_paise, r.deferred_paise, r.owner_note, r.decided_at, r.created_at"""


def _first(m: date) -> date:
    return m.replace(day=1)


def _next_month(m: date) -> date:
    return date(m.year + (m.month // 12), m.month % 12 + 1, 1)


def relief_view(row) -> dict:
    d = dict(row)
    for k in ("requested_pay_paise", "billed_paise", "open_paise", "agreed_pay_paise", "deferred_paise"):
        if d.get(k) is not None:
            d[k.replace("_paise", "_display")] = format_inr(d[k])
    d["next_month"] = _next_month(d["period_month"]).isoformat() if d.get("period_month") else None
    return d


def month_relief(db: Db, tenancy_id: UUID, month: date) -> dict | None:
    """The request that matters for a month: an open one, else the approved one, else the latest closed one."""
    row = db.one(f"""SELECT {COLUMNS} FROM rent_relief r WHERE r.tenancy_id = :t AND r.period_month = :m
                     ORDER BY (r.status = 'requested') DESC, (r.status = 'approved') DESC, r.created_at DESC LIMIT 1""", t=tenancy_id, m=month)
    return relief_view(row) if row else None


def _open_for_month(db: Db, tenancy_id: UUID, month: date) -> int:
    inv = db.one("SELECT open_paise FROM v_invoice_status WHERE tenancy_id = :t AND period_month = :m", t=tenancy_id, m=month)
    if inv is None:
        raise AppError("VALIDATION", "there is no bill for that month yet", fields=[{"field": "period_month", "code": "no_bill"}])
    if inv["open_paise"] <= 0:
        raise AppError("VALIDATION", "nothing is unpaid for that month", fields=[{"field": "period_month", "code": "nothing_due"}])
    return int(inv["open_paise"])


def _owner_users(db: Db, owner: UUID) -> list[UUID]:
    return [r["user_id"] for r in db.all("SELECT user_id FROM owner_memberships WHERE owner_account_id = :o AND status = 'active'", o=owner)]


def _unit(db: Db, tenancy_id: UUID) -> str:
    return db.scalar("SELECT u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.id = :t", t=tenancy_id)


class RequestIn(BaseModel):
    period_month: date
    pay_amount: str | int                                  # what the renter can pay now towards that month
    reason: str | None = Field(default=None, max_length=250)


@router.post("/tenancies/{tenancy_id}/rent-relief")
def request_relief(tenancy_id: UUID, body: RequestIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """The renter asks to pay less than the full month now. Nothing changes on the bill until the owner agrees."""
    t = tenant_tenancy(db, user, tenancy_id)
    if t["status"] != "active":
        raise AppError("INVALID_STATE", "this rental has ended")
    limiter.check(f"relief:{user.id}", 10, 3600)
    month = _first(body.period_month)
    pay = parse_inr(body.pay_amount, field="pay_amount", allow_zero=True)
    open_ = _open_for_month(db, tenancy_id, month)
    if pay >= open_:
        raise AppError("VALIDATION", f"you can pay the full amount ({format_inr(open_)}), so no relief is needed",
                       fields=[{"field": "pay_amount", "code": "not_less_than_due"}], open_paise=open_)
    if db.scalar("SELECT 1 FROM rent_relief WHERE tenancy_id = :t AND period_month = :m AND status IN ('requested','approved')", t=tenancy_id, m=month):
        raise AppError("CONFLICT", "there is already a relief request or agreement for this month", status=409)
    rid = db.scalar("""INSERT INTO rent_relief(owner_account_id, tenancy_id, period_month, initiated_by, requested_pay_paise, reason, requested_by)
                       VALUES (:o, :t, :m, 'renter', :p, :r, :u) RETURNING id""",
                    o=t["owner_account_id"], t=tenancy_id, m=month, p=pay, r=clean_text(body.reason) if body.reason else None, u=user.id)
    db.audit(user.id, t["owner_account_id"], "rent_relief.requested", "rent_relief", rid, after={"month": str(month), "pay_paise": pay})
    name = db.scalar("SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = :t ORDER BY created_at DESC LIMIT 1", t=tenancy_id) or "Your renter"
    for uid in _owner_users(db, t["owner_account_id"]):
        notify.enqueue(db, uid, "relief_requested", {"tenant": name, "unit": _unit(db, tenancy_id), "month": f"{month:%b %Y}", "amount": format_inr(pay),
                                                     "due": format_inr(open_)}, f"relief-req:{rid}:{uid}", t["owner_account_id"])
    return relief_view(db.one(f"SELECT {COLUMNS} FROM rent_relief r WHERE r.id = :i", i=rid))


@router.get("/tenancies/{tenancy_id}/rent-relief")
def list_relief(tenancy_id: UUID, month: date | None = None, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    tenancy_party(db, user, tenancy_id)
    rows = db.all(f"""SELECT {COLUMNS} FROM rent_relief r WHERE r.tenancy_id = :t AND (CAST(:m AS date) IS NULL OR r.period_month = :m)
                      ORDER BY r.period_month DESC, r.created_at DESC LIMIT 50""", t=tenancy_id, m=_first(month) if month else None)
    return {"items": [relief_view(r) for r in rows]}


@router.post("/rent-relief/{relief_id}/cancel")
def cancel_relief(relief_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    r = db.one("SELECT * FROM rent_relief WHERE id = :i AND requested_by = :u AND initiated_by = 'renter'", i=relief_id, u=user.id)
    if r is None:
        raise AppError("NOT_FOUND", "request not found")
    if r["status"] != "requested":
        raise AppError("INVALID_STATE", "this request has already been decided")
    db.exec("UPDATE rent_relief SET status = 'cancelled', decided_at = now() WHERE id = :i", i=relief_id)
    db.audit(user.id, r["owner_account_id"], "rent_relief.cancelled", "rent_relief", relief_id)
    return {"status": "cancelled"}


class DecideIn(BaseModel):
    action: Literal["approve", "decline"]
    pay_amount: str | int | None = None                   # approve: what must be paid now for that month; the rest moves to next month
    note: str | None = Field(default=None, max_length=250)


def _tell_renter(db: Db, t: dict, rid: UUID, month: date, approved: bool, agreed: int, deferred: int, owner: UUID, note: str | None) -> None:
    if not t["tenant_user_id"]:
        return
    owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=owner)
    if approved:
        notify.enqueue(db, t["tenant_user_id"], "relief_approved", {"owner": owner_name, "unit": _unit(db, t["id"]), "month": f"{month:%b %Y}",
                       "amount": format_inr(agreed), "deferred": format_inr(deferred), "next": f"{_next_month(month):%b %Y}"}, f"relief-ok:{rid}", owner)
    else:
        notify.enqueue(db, t["tenant_user_id"], "relief_declined", {"owner": owner_name, "unit": _unit(db, t["id"]), "month": f"{month:%b %Y}"},
                       f"relief-no:{rid}", owner)


@router.post("/owner/rent-relief/{relief_id}/decide")
def decide_relief(relief_id: UUID, body: DecideIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    r = db.one("SELECT * FROM rent_relief WHERE id = :i AND owner_account_id = :o", i=relief_id, o=scope.owner_account_id)
    if r is None:
        raise AppError("NOT_FOUND", "request not found")
    t = owned_tenancy(db, scope, r["tenancy_id"])
    note = clean_text(body.note) if body.note else None
    if body.action == "decline":
        if r["status"] != "requested":
            raise AppError("INVALID_STATE", "this request has already been decided")
        db.exec("UPDATE rent_relief SET status = 'declined', owner_note = :n, decided_by = :u, decided_at = now() WHERE id = :i", n=note, u=scope.user.id, i=relief_id)
        db.audit(scope.user.id, scope.owner_account_id, "rent_relief.declined", "rent_relief", relief_id)
        _tell_renter(db, t, relief_id, r["period_month"], False, 0, 0, scope.owner_account_id, note)
    else:
        if body.pay_amount is None:
            raise AppError("VALIDATION", "enter the amount to be paid now", fields=[{"field": "pay_amount", "code": "required"}])
        agreed = parse_inr(body.pay_amount, field="pay_amount", allow_zero=True)
        db.scalar("SELECT rg_apply_rent_relief(:i, :a, :n, :u)", i=relief_id, a=agreed, n=note, u=scope.user.id)
        done = db.one("SELECT * FROM rent_relief WHERE id = :i", i=relief_id)
        db.audit(scope.user.id, scope.owner_account_id, "rent_relief.approved", "rent_relief", relief_id,
                 after={"agreed_pay_paise": agreed, "deferred_paise": done["deferred_paise"]})
        _tell_renter(db, t, relief_id, r["period_month"], True, agreed, int(done["deferred_paise"]), scope.owner_account_id, note)
    return relief_view(db.one(f"SELECT {COLUMNS} FROM rent_relief r WHERE r.id = :i", i=relief_id))


class GrantIn(BaseModel):
    period_month: date
    pay_amount: str | int
    note: str | None = Field(default=None, max_length=250)


@router.post("/owner/tenancies/{tenancy_id}/rent-relief")
def grant_relief(tenancy_id: UUID, body: GrantIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """The owner changes what is payable for a month without waiting for a request."""
    t = owned_tenancy(db, scope, tenancy_id)
    month = _first(body.period_month)
    agreed = parse_inr(body.pay_amount, field="pay_amount", allow_zero=True)
    _open_for_month(db, tenancy_id, month)
    if db.scalar("SELECT 1 FROM rent_relief WHERE tenancy_id = :t AND period_month = :m AND status = 'approved'", t=tenancy_id, m=month):
        raise AppError("CONFLICT", "relief has already been agreed for this month", status=409)
    db.exec("UPDATE rent_relief SET status = 'cancelled', decided_at = now() WHERE tenancy_id = :t AND period_month = :m AND status = 'requested'", t=tenancy_id, m=month)
    rid = db.scalar("""INSERT INTO rent_relief(owner_account_id, tenancy_id, period_month, initiated_by, requested_by) VALUES (:o, :t, :m, 'owner', :u) RETURNING id""",
                    o=scope.owner_account_id, t=tenancy_id, m=month, u=scope.user.id)
    note = clean_text(body.note) if body.note else None
    db.scalar("SELECT rg_apply_rent_relief(:i, :a, :n, :u)", i=rid, a=agreed, n=note, u=scope.user.id)
    done = db.one("SELECT * FROM rent_relief WHERE id = :i", i=rid)
    db.audit(scope.user.id, scope.owner_account_id, "rent_relief.granted", "rent_relief", rid, after={"agreed_pay_paise": agreed, "deferred_paise": done["deferred_paise"]})
    _tell_renter(db, t, rid, month, True, agreed, int(done["deferred_paise"]), scope.owner_account_id, note)
    return relief_view(db.one(f"SELECT {COLUMNS} FROM rent_relief r WHERE r.id = :i", i=rid))


@router.get("/owner/rent-relief")
def pending_relief(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """Requests waiting for the owner, newest first."""
    rows = db.all(f"""SELECT {COLUMNS}, u.identifier, (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = r.tenancy_id ORDER BY created_at DESC LIMIT 1) AS tenant_name
                      FROM rent_relief r JOIN tenancies t ON t.id = r.tenancy_id JOIN units u ON u.id = t.unit_id
                      WHERE r.owner_account_id = :o AND r.status = 'requested' ORDER BY r.created_at DESC LIMIT 100""", o=scope.owner_account_id)
    return {"items": [relief_view(r) for r in rows]}
