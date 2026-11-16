"""Agreements. When a rental's agreement is about to end (or has ended) both sides are reminded in the bell until the owner renews it.
Renewing before the end date is an EXTENSION; renewing after it lapsed starts a NEW agreement. Either way a new row is added to the
agreement history and the old rows stay exactly as they were. The yearly increase is read from the rental (set in its terms), shown
to both sides as a read-only label, and applied as a rent change from the first month of the renewed period."""
from __future__ import annotations

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope, tenancy_party
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..domain.money import format_inr
from ..domain.validation import clean_text
from . import notify

router = APIRouter(prefix="/api/v1", tags=["agreements"])

WARN_DAYS = 30                       # the bell starts reminding this many days before the agreement ends
MAX_YEARS = 11


def _today(db: Db) -> date:
    return db.scalar("SELECT rg_today()")


def _first_of_month_on_or_after(d: date) -> date:
    return d if d.day == 1 else date(d.year + (d.month // 12), d.month % 12 + 1, 1)


def ensure_original(db: Db, t: dict) -> None:
    """The first row of the history: the agreement the rental started with. Created once, for rentals made before this existed too."""
    if db.scalar("SELECT 1 FROM tenancy_agreements WHERE tenancy_id = :t", t=t["id"]):
        return
    db.exec("""INSERT INTO tenancy_agreements(owner_account_id, tenancy_id, seq, kind, start_date, end_date, monthly_rent_paise, increment_percent, created_by)
               VALUES (:o, :t, 1, 'original', :s, :e, :r, NULL, :by)""",
            o=t["owner_account_id"], t=t["id"], s=t["start_date"], e=t["end_date"], r=t["monthly_rent_paise"], by=t.get("created_by"))


def rent_on(db: Db, t: dict, month: date) -> int:
    return int(db.scalar("""SELECT COALESCE((SELECT monthly_rent_paise FROM rent_revisions WHERE tenancy_id = :t AND effective_month <= :m
                                              ORDER BY effective_month DESC LIMIT 1), :base)""", t=t["id"], m=month, base=t["monthly_rent_paise"]))


def increase(rent_paise: int, percent: Decimal | None) -> int:
    """The rent after the yearly increase, to a whole rupee (half up). No increase configured: unchanged."""
    if not percent or percent <= 0:
        return rent_paise
    rupees = (Decimal(rent_paise) / 100 * (100 + percent) / 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return int(rupees) * 100


def _status(end: date | None, today: date) -> tuple[str, int | None]:
    if end is None:
        return "open", None
    days = (end - today).days
    return ("lapsed" if days < 0 else "ending_soon" if days <= WARN_DAYS else "running"), days


def agreement_view(db: Db, t: dict, role: str) -> dict:
    today = _today(db)
    ensure_original(db, t)
    state, days = _status(t["end_date"], today)
    percent = t.get("increment_percent")
    start = (t["end_date"] + timedelta(days=1)) if t["end_date"] else None
    eff = _first_of_month_on_or_after(start) if start else None
    cur = rent_on(db, t, today.replace(day=1))
    new = increase(cur, percent)
    hist = db.all("""SELECT seq, kind, start_date, end_date, monthly_rent_paise, increment_percent, note, created_at FROM tenancy_agreements
                     WHERE tenancy_id = :t ORDER BY seq DESC""", t=t["id"])
    names = db.one("""SELECT u.identifier, o.display_name, (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) AS renter
                      FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN owner_accounts o ON o.id = t.owner_account_id WHERE t.id = :t""", t=t["id"])
    return {
        "tenancy_id": str(t["id"]), "viewer_role": role, "owner_account_id": str(t["owner_account_id"]) if role == "owner" else None, "unit": names["identifier"], "owner_name": names["display_name"], "renter_name": names["renter"],
        "start_date": t["start_date"], "end_date": t["end_date"], "days_left": days, "state": state, "warn_days": WARN_DAYS,
        "current_rent_paise": cur, "current_rent_display": format_inr(cur),
        "increment_percent": str(percent) if percent is not None else None,
        "increment_paise": new - cur, "increment_display": format_inr(new - cur),
        "new_rent_paise": new, "new_rent_display": format_inr(new), "new_rent_from": eff,
        "new_start_date": start, "will_be": ("extension" if state != "lapsed" else "new") if t["end_date"] else None,
        "can_renew": role == "owner" and t["status"] == "active" and t["end_date"] is not None,
        "history": [dict(h, monthly_rent_display=format_inr(h["monthly_rent_paise"])) for h in hist],
    }


@router.get("/tenancies/{tenancy_id}/agreement")
def get_agreement(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    t, role, _ = tenancy_party(db, user, tenancy_id)
    return agreement_view(db, t, role)


class RenewIn(BaseModel):
    new_end_date: date
    note: str | None = Field(default=None, max_length=250)


@router.post("/owner/tenancies/{tenancy_id}/agreement/renew")
def renew_agreement(tenancy_id: UUID, body: RenewIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    t = owned_tenancy(db, scope, tenancy_id, lock=True)
    if t["status"] != "active":
        raise AppError("INVALID_STATE", "only a running rental can be renewed")
    db.scalar("SELECT rg_require_owner_writable(:o)", o=scope.owner_account_id)
    if t["end_date"] is None:
        raise AppError("INVALID_STATE", "this rental has no end date, so there is nothing to renew")
    today = _today(db)
    if body.new_end_date <= max(t["end_date"], today):
        raise AppError("VALIDATION", "the new end date must be after the current end date and after today", fields=[{"field": "new_end_date", "code": "end_before_start"}])
    if body.new_end_date > today + timedelta(days=365 * MAX_YEARS + 3):
        raise AppError("VALIDATION", f"the new end date can be at most {MAX_YEARS} years away", fields=[{"field": "new_end_date", "code": "too_far"}])
    ensure_original(db, t)
    kind = "extension" if today <= t["end_date"] else "new"
    start = t["end_date"] + timedelta(days=1)
    eff = _first_of_month_on_or_after(start)
    percent = t.get("increment_percent")
    cur = rent_on(db, t, eff)
    new = increase(cur, percent)
    if new != cur:                                           # the yearly increase becomes a rent change from the first month of the renewed period
        db.exec("""INSERT INTO rent_revisions(tenancy_id, effective_month, monthly_rent_paise, created_by) VALUES (:t, :m, :a, :by)
                   ON CONFLICT (tenancy_id, effective_month) DO UPDATE SET monthly_rent_paise = EXCLUDED.monthly_rent_paise""",
                t=tenancy_id, m=eff, a=new, by=scope.user.id)
    seq = db.scalar("SELECT max(seq) + 1 FROM tenancy_agreements WHERE tenancy_id = :t", t=tenancy_id)
    db.exec("""INSERT INTO tenancy_agreements(owner_account_id, tenancy_id, seq, kind, start_date, end_date, monthly_rent_paise, increment_percent, note, created_by)
               VALUES (:o, :t, :s, :k, :sd, :ed, :r, :p, :n, :by)""",
            o=scope.owner_account_id, t=tenancy_id, s=seq, k=kind, sd=start, ed=body.new_end_date, r=new, p=percent,
            n=clean_text(body.note) if body.note else None, by=scope.user.id)
    db.exec("UPDATE tenancies SET end_date = :e, version = version + 1 WHERE id = :t", e=body.new_end_date, t=tenancy_id)
    db.audit(scope.user.id, scope.owner_account_id, f"agreement.{kind}", "tenancy", tenancy_id,
             before={"end_date": str(t["end_date"]), "rent_paise": cur}, after={"end_date": str(body.new_end_date), "rent_paise": new, "increment_percent": str(percent) if percent is not None else None})
    from .billing import backfill_invoices
    backfill_invoices(db, tenancy_id)                        # months the lapsed agreement left unbilled are billed now, at the rent that applied
    if t["tenant_user_id"]:
        owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
        unit = db.scalar("SELECT u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.id = :t", t=tenancy_id)
        rent = f"{format_inr(new)} from {eff:%b %Y}" if new != cur else f"{format_inr(cur)} (unchanged)"
        notify.enqueue(db, t["tenant_user_id"], "agreement_renewed", {"owner": owner_name, "unit": unit, "date": f"{body.new_end_date:%d-%m-%Y}", "rent": rent, "tenancy_id": str(tenancy_id)},
                       f"agreement:{tenancy_id}:{seq}", scope.owner_account_id)
    fresh = owned_tenancy(db, scope, tenancy_id)
    return dict(agreement_view(db, fresh, "owner"), renewed_as=kind)


def renewal_alerts(db: Db, user_id: UUID, role: Literal["owner", "tenant"]) -> list[dict]:
    """Rentals whose agreement ends within WARN_DAYS (or already ended) and has not been renewed, for the person in this role."""
    who = ("t.owner_account_id IN (SELECT owner_account_id FROM owner_memberships WHERE user_id = :u AND status = 'active')"
           if role == "owner" else "t.tenant_user_id = :u")
    rows = db.all(f"""SELECT t.id, t.end_date, u.identifier, (t.end_date - rg_today()) AS days_left,
                             (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) AS renter
                      FROM tenancies t JOIN units u ON u.id = t.unit_id
                      WHERE {who} AND t.status = 'active' AND t.end_date IS NOT NULL AND t.end_date <= rg_today() + :w
                      ORDER BY t.end_date, u.identifier LIMIT 50""", u=user_id, w=WARN_DAYS)
    return [dict(r) for r in rows]
