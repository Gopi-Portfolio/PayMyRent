"""Privacy rights (DPDP): download my data, and close my account.

Closing removes personal details (name, address, mobile/email, PAN) and signs the person out everywhere.
Financial records (bills, payments, receipts, ledger) are immutable by design and must be kept for accounting/tax; they remain,
tied to an anonymous account, so the other party's history stays correct."""
from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from ..core.auth import CurrentUser, current_user
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter

router = APIRouter(prefix="/api/v1", tags=["privacy"])


@router.get("/me/export")
def export_my_data(fmt: Literal["json", "csv", "pdf"] = Query("json", alias="format"), user: CurrentUser = Depends(current_user), db: Db = Depends(get_db)):
    """The person's own data. The app always asks for csv or pdf (what people can open and keep); json stays for programs that call the API."""
    limiter.check(f"export:{user.id}", 5, 3600)
    u = db.must("SELECT id, full_name, address, preferred_language, created_at FROM users WHERE id = :u", "user", u=user.id)
    rows = lambda q: [dict(r) for r in db.all(q, u=user.id)]  # noqa: E731
    data = {
        "profile": dict(u),
        "roles": [r["role"] for r in db.all("SELECT role FROM user_roles WHERE user_id = :u", u=user.id)],
        "contacts": rows("SELECT kind, value, is_primary, verified_at, removed_at FROM user_contacts WHERE user_id = :u"),
        "consents": rows("SELECT channel, granted, source, notice_version, created_at FROM consent_records WHERE user_id = :u ORDER BY created_at"),
        "owner_details": rows("""SELECT v.legal_name, v.address, v.pan_masked, v.proof_type, v.proof_ref, v.status FROM owner_verifications v
                                 JOIN owner_memberships m ON m.owner_account_id = v.owner_account_id WHERE m.user_id = :u"""),
        "tenancies_as_renter": rows("""SELECT t.id, u.identifier AS unit, t.start_date, t.end_date, t.status, t.monthly_rent_paise
                                       FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.tenant_user_id = :u"""),
        "tenancies_as_owner": rows("""SELECT t.id, u.identifier AS unit, t.start_date, t.end_date, t.status, t.monthly_rent_paise
                                      FROM tenancies t JOIN units u ON u.id = t.unit_id
                                      JOIN owner_memberships m ON m.owner_account_id = t.owner_account_id WHERE m.user_id = :u"""),
        "notes": rows("SELECT target_type, body, created_at FROM notes WHERE author_user_id = :u ORDER BY created_at"),
    }
    return data if fmt == "json" else _file(data, fmt)


TITLES = {"profile": "Profile", "roles": "Roles", "contacts": "Contacts", "consents": "Message consents", "owner_details": "Owner details",
          "tenancies_as_renter": "Rentals as renter", "tenancies_as_owner": "Rentals as owner", "notes": "Notes"}


def _file(data: dict, fmt: str) -> Response:
    """The same data as a CSV or PDF. A single record becomes Field/Value rows; a list becomes a table with its own columns."""
    from ..domain import report_files as rf
    tables = []
    for key, name in TITLES.items():
        v = data[key]
        if isinstance(v, dict):
            tables.append(rf.table(name, ["Field", "Value"], [[k, x] for k, x in v.items()]))
        elif v and isinstance(v[0], dict):
            heads = list(v[0].keys())
            tables.append(rf.table(name, heads, [[r[h] for h in heads] for r in v]))
        else:
            tables.append(rf.table(name, [name], [[x] for x in v] or [["None"]]))
    title, sub = "RentMeezy — My data", f"As on {date.today():%d-%m-%Y}"
    if fmt == "csv":
        body, mime = rf.make_csv(title, sub, tables), rf.CSV
    else:
        try:
            body, mime = rf.make_pdf(title, sub, tables), rf.PDF
        except ImportError:
            raise AppError("PDF_UNAVAILABLE", "PDF is not available on this server right now. Download the CSV file instead.", status=503) from None
    return Response(body, media_type=mime, headers={"Content-Disposition": f'attachment; filename="rentmeezy-my-data-{date.today():%Y%m%d}.{fmt}"', "Cache-Control": "no-store"})


class CloseIn(BaseModel):
    confirm: str
    close_rentals: bool = False        # an owner who chose NOT to transfer: end every live rental of the account(s) they own, then close


def _close_owned_rentals(db: Db, user_id) -> None:  # noqa: ANN001
    """The main owner is closing without handing the account over: every live rental of that account ends today, renters are told, access ends."""
    from . import notify
    for acc in db.all("SELECT owner_account_id FROM owner_memberships WHERE user_id = :u AND role = 'owner' AND status = 'active'", u=user_id):
        o = acc["owner_account_id"]
        for t in db.all("""SELECT t.id, t.status, t.start_date, t.tenant_user_id, u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id
                           WHERE t.owner_account_id = :o AND t.status IN ('invited','active')""", o=o):
            end = max(date.today(), t["start_date"] + timedelta(days=1))
            db.scalar("SELECT rg_end_tenancy(:t, :d, :by)", t=t["id"], d=end, by=user_id)
            if t["tenant_user_id"]:
                notify.enqueue(db, t["tenant_user_id"], "tenancy_closed", {"unit": t["identifier"]}, f"closed:{t['id']}", o)
        db.exec("UPDATE owner_memberships SET status = 'revoked' WHERE owner_account_id = :o", o=o)
        db.exec("UPDATE owner_subscriptions SET status = 'expired', updated_at = now() WHERE owner_account_id = :o AND status IN ('active','grace')", o=o)
        db.audit(user_id, o, "owner.closed_with_rentals", "owner_account", o)


@router.post("/me/close-account")
def close_account(body: CloseIn, user: CurrentUser = Depends(current_user), db: Db = Depends(get_db)) -> dict:
    if body.confirm.strip().upper() != "DELETE":
        raise AppError("VALIDATION", "type DELETE to confirm", fields=[{"field": "confirm", "code": "required"}])
    if body.close_rentals:
        _close_owned_rentals(db, user.id)
    live = db.scalar("""SELECT count(*) FROM tenancies t WHERE t.status IN ('invited','active') AND
                          (t.tenant_user_id = :u OR t.owner_account_id IN (SELECT owner_account_id FROM owner_memberships WHERE user_id = :u AND status = 'active'))""",
                     u=user.id)
    if live:
        raise AppError("INVALID_STATE", "you still have active rentals: ask each owner to let you vacate (Profile → Close account), then close the account")
    db.exec("""UPDATE owner_verifications SET legal_name = 'Closed account', address = 'Removed', pan_enc = NULL, pan_hash = NULL, pan_masked = NULL,
                 proof_ref = 'removed', status = 'rejected', updated_at = now()
               WHERE owner_account_id IN (SELECT owner_account_id FROM owner_memberships WHERE user_id = :u)""", u=user.id)
    db.exec("UPDATE user_contacts SET removed_at = now(), is_primary = false WHERE user_id = :u AND removed_at IS NULL", u=user.id)
    db.exec("""UPDATE users SET full_name = 'Closed account', address = NULL, status = 'closed', firebase_uid = 'closed:' || id::text,
                 sessions_valid_after = now(), updated_at = now() WHERE id = :u""", u=user.id)
    db.audit(user.id, None, "account.closed", "user", user.id)
    return {"status": "closed"}
