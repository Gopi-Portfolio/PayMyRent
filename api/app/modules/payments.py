"""Rent payments (tenant → owner money flow): cash, manual transfers, gateway checkout,
webhooks, reversals, receipts, deposits, payout accounts. Clients never set a paid status."""
from __future__ import annotations

import json
import re
import time
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope, tenancy_party, tenant_tenancy
from ..core.config import get_settings
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..core.http import limiter
from ..domain.money import format_inr, parse_inr
from ..domain.validation import validate_note
from ..providers.payments import get_provider
from . import notify

router = APIRouter(prefix="/api/v1", tags=["payments"])


def _unit_label(db: Db, tenancy_id: UUID) -> str:
    return db.scalar("SELECT u.identifier FROM tenancies t JOIN units u ON u.id = t.unit_id WHERE t.id = :t", t=tenancy_id)


def _within_due(db: Db, tenancy_id: UUID, amount: int, key: str) -> None:
    """A payment can never be more than what is due right now (the server's balance, not the app's).
    A retry of a payment that is already recorded (same key) is not checked again, it just returns that payment."""
    if db.scalar("SELECT 1 FROM payments WHERE tenancy_id = :t AND idempotency_key = :k", t=tenancy_id, k=key):
        return
    due = max(db.scalar("SELECT payable_now_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id) or 0, 0)
    if amount > due:
        raise AppError("VALIDATION", f"the amount cannot be more than the due amount ({format_inr(due)})",
                       fields=[{"field": "amount", "code": "more_than_due"}], due_paise=due)


def _payment_out(db: Db, pid: UUID) -> dict:
    p = db.one("""SELECT p.*, r.id AS receipt_id, r.number AS receipt_number FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id
                  WHERE p.id = :p""", p=pid)
    allocs = db.all("""SELECT i.period_month, l.category, sum(a.amount_paise) AS amount_paise FROM payment_allocations a
                       JOIN invoice_lines l ON l.id = a.invoice_line_id JOIN monthly_invoices i ON i.id = l.invoice_id
                       WHERE a.payment_id = :p GROUP BY 1, 2 HAVING sum(a.amount_paise) <> 0 ORDER BY 1, 2""", p=pid)
    bal = db.scalar("SELECT balance_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=p["tenancy_id"])
    out = {k: p[k] for k in ("id", "tenancy_id", "method", "verification", "status", "amount_paise", "paid_on", "tenant_ack",
                             "is_demo", "receipt_id", "receipt_number", "checkout")}
    out.update(amount_display=format_inr(p["amount_paise"]), allocations=[dict(a) for a in allocs], balance_after_paise=bal,
               balance_after_display=format_inr(bal))
    return out


# ───────────────────────── cash (owner-recorded) ─────────────────────────
class CashIn(BaseModel):
    amount: str | int
    paid_on: date | None = None
    idempotency_key: str = Field(min_length=8, max_length=80)
    note: str | None = None
    cash_received_confirmed: bool = False      # the owner read the notice and confirms the cash was personally received


@router.post("/owner/tenancies/{tenancy_id}/payments/cash")
def record_cash(tenancy_id: UUID, body: CashIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """Select tenant → amount → confirm. Immediately in the ledger, labelled owner-recorded."""
    t = owned_tenancy(db, scope, tenancy_id)                    # whose tenancy first, so a stranger learns nothing from the next check
    if not body.cash_received_confirmed:
        raise AppError("VALIDATION", "confirm that you have received this cash before recording it",
                       fields=[{"field": "cash_received_confirmed", "code": "required"}])
    amount = parse_inr(body.amount)
    _within_due(db, tenancy_id, amount, body.idempotency_key)
    note = validate_note(body.note, "note") if body.note else None
    pid = db.scalar("SELECT rg_record_payment(:t, 'cash', :a, :d, :k, :by)", t=tenancy_id, a=amount,
                    d=body.paid_on or date.today(), k=body.idempotency_key, by=scope.user.id)
    if note:
        db.exec("""INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body)
                   SELECT :o, :t, 'payment', :p, :u, 'owner', :b WHERE NOT EXISTS
                   (SELECT 1 FROM notes WHERE target_type = 'payment' AND target_id = :p)""",
                o=scope.owner_account_id, t=tenancy_id, p=pid, u=scope.user.id, b=note)
    db.audit(scope.user.id, scope.owner_account_id, "payment.cash_recorded", "payment", pid, after={"amount_paise": amount, "owner_confirmed_cash_received": True})
    if t["tenant_user_id"]:
        owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
        notify.enqueue(db, t["tenant_user_id"], "cash_recorded", {"owner": owner_name, "amount": format_inr(amount),
                       "unit": _unit_label(db, tenancy_id)}, f"cash:{pid}", scope.owner_account_id)
    return _payment_out(db, pid)


class ReverseIn(BaseModel):
    reason: str = Field(min_length=3, max_length=250)


@router.post("/owner/payments/{payment_id}/reverse")
def reverse_payment(payment_id: UUID, body: ReverseIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    p = db.must("SELECT * FROM payments WHERE id = :p AND owner_account_id = :o", "payment", p=payment_id, o=scope.owner_account_id)
    if p["method"] == "gateway":
        raise AppError("INVALID_STATE", "gateway payments are refunded through the payment provider, not reversed here")
    db.scalar("SELECT rg_reverse_payment(:p, :by, :r)", p=payment_id, by=scope.user.id, r=body.reason)
    db.audit(scope.user.id, scope.owner_account_id, "payment.reversed", "payment", payment_id, after={"reason": body.reason})
    return _payment_out(db, payment_id)


@router.post("/owner/payments/{payment_id}/confirm-transfer")
def confirm_transfer(payment_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    db.must("SELECT 1 FROM payments WHERE id = :p AND owner_account_id = :o", "payment", p=payment_id, o=scope.owner_account_id)
    db.scalar("SELECT rg_owner_confirm_transfer(:p, :by)", p=payment_id, by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "payment.transfer_confirmed", "payment", payment_id)
    out = _payment_out(db, payment_id)
    t = db.one("SELECT t.tenant_user_id, t.id FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.id = :p", p=payment_id)
    if t and t["tenant_user_id"]:
        notify.enqueue(db, t["tenant_user_id"], "payment_received", {"amount": out["amount_display"], "unit": _unit_label(db, t["id"]),
                       "receipt": out["receipt_number"]}, f"paid:{payment_id}", scope.owner_account_id)
    return out


class RejectIn(BaseModel):
    reason: str | None = Field(default=None, max_length=250)


@router.post("/owner/payments/{payment_id}/reject-transfer")
def reject_transfer(payment_id: UUID, body: RejectIn | None = None, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """The owner did not receive this transfer. The report is closed; the dues do not change."""
    db.must("SELECT 1 FROM payments WHERE id = :p AND owner_account_id = :o", "payment", p=payment_id, o=scope.owner_account_id)
    reason = (body.reason or "").strip() if body else ""
    db.scalar("SELECT rg_owner_reject_transfer(:p, :by, :r)", p=payment_id, by=scope.user.id, r=reason or None)
    db.audit(scope.user.id, scope.owner_account_id, "payment.transfer_rejected", "payment", payment_id, after={"reason": reason or None})
    t = db.one("SELECT t.tenant_user_id, t.id, p.amount_paise FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.id = :p", p=payment_id)
    if t and t["tenant_user_id"]:
        owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
        notify.enqueue(db, t["tenant_user_id"], "transfer_rejected", {"owner": owner_name, "amount": format_inr(t["amount_paise"]), "unit": _unit_label(db, t["id"])},
                       f"transfer-rejected:{payment_id}", scope.owner_account_id)
    return _payment_out(db, payment_id)


@router.get("/owner/payments/pending-transfers")
def pending_transfers(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """UPI / bank transfers the tenants say they made, waiting for the owner to check their bank or UPI app."""
    rows = db.all("""SELECT p.id, p.tenancy_id, p.amount_paise, p.paid_on, p.created_at, u.identifier,
                            (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) AS tenant_name,
                            (SELECT e.data->>'reference' FROM payment_events e WHERE e.payment_id = p.id AND e.type = 'tenant_reference' LIMIT 1) AS reference
                     FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
                     WHERE p.owner_account_id = :o AND p.method = 'manual_transfer' AND p.status = 'pending'
                     ORDER BY p.created_at DESC LIMIT 200""", o=scope.owner_account_id)
    return {"items": [dict(r, amount_display=format_inr(r["amount_paise"])) for r in rows]}


# ───────────────────────── how the owner wants to receive rent, per tenant ─────────────────────────
_UPI_RE = re.compile(r"^[a-z0-9._-]{2,64}@[a-z][a-z0-9]{2,32}$")


def online_available() -> bool:
    """Online checkout is real only with a live payment provider. The sandbox one is a demo, so the app does not offer it to renters."""
    s = get_settings()
    return bool(s.rent_online_enabled and s.rent_provider != "sandbox")


def owner_default_method(db: Db, owner: UUID) -> str | None:
    """The owner's usual way of receiving rent (profile). Tenants without a choice of their own follow it."""
    return db.scalar("SELECT default_pay_method FROM owner_accounts WHERE id = :o", o=owner)


def owner_default_upi(db: Db, owner: UUID) -> str | None:
    """The UPI ID saved in the owner's profile: used for every tenant set to UPI unless that tenant has its own."""
    return db.scalar("SELECT default_upi_id FROM owner_accounts WHERE id = :o", o=owner)


def known_upi_ids(db: Db, owner: UUID) -> list[str]:
    """UPI IDs this owner already approved with a code: the profile one first, then any used for a single tenant."""
    own = [r["pay_upi_id"] for r in db.all("""SELECT pay_upi_id FROM tenancies WHERE owner_account_id = :o AND pay_upi_id IS NOT NULL
                                              GROUP BY pay_upi_id ORDER BY max(updated_at) DESC LIMIT 20""", o=owner)]
    default = owner_default_upi(db, owner)
    return ([default] if default else []) + [u for u in own if u != default]


def _clean_upi(upi_id: str | None) -> str | None:
    upi = (upi_id or "").strip().lower()
    if not upi:
        return None
    if not _UPI_RE.match(upi):
        raise AppError("VALIDATION", "enter a valid UPI ID, for example name@okhdfcbank", fields=[{"field": "pay_upi_id", "code": "upi_invalid"}])
    return upi


def _approve_new_upi(db: Db, scope: OwnerScope, upi: str, otp_code: str | None) -> None:
    """A UPI ID the owner has not used before sends money to a new place: the same one-time code as a payout account,
    and only the account owner (not a manager) may add it."""
    if upi in known_upi_ids(db, scope.owner_account_id):
        return
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account owner can add a new UPI ID")
    from .action_otp import require_action_otp
    require_action_otp(db, scope.user.id, "payout", otp_code)
    notify.security_event(db, scope.user.id, None, "payout_details_changed")


def resolve_pay_method(db: Db, scope: OwnerScope, method: str | None, upi_id: str | None, otp_code: str | None) -> tuple[str, str | None]:
    """Checks the owner's choice and returns (method, override). For UPI the owner's profile UPI ID is used unless a different one is
    given for this tenant (the override). The first UPI ID an owner ever gives is saved to the profile as their default."""
    if method not in ("upi", "online", "cash"):
        raise AppError("VALIDATION", "choose how you want to receive rent from this tenant", fields=[{"field": "pay_method", "code": "required"}])
    if method != "upi":
        return method, None
    upi, default = _clean_upi(upi_id), owner_default_upi(db, scope.owner_account_id)
    if upi is None:
        if not default:
            raise AppError("VALIDATION", "enter your UPI ID", fields=[{"field": "pay_upi_id", "code": "upi_required"}])
        return method, None                                  # follows the profile UPI ID
    if upi == default:
        return method, None
    _approve_new_upi(db, scope, upi, otp_code)
    if default is None:
        db.exec("UPDATE owner_accounts SET default_upi_id = :u WHERE id = :o", u=upi, o=scope.owner_account_id)
        return method, None
    return method, upi


@router.get("/owner/upi-ids")
def my_upi_ids(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    last = db.scalar("""SELECT pay_method FROM tenancies WHERE owner_account_id = :o AND pay_method IS NOT NULL ORDER BY updated_at DESC, created_at DESC LIMIT 1""",
                     o=scope.owner_account_id)
    return {"upi_ids": known_upi_ids(db, scope.owner_account_id), "default_upi_id": owner_default_upi(db, scope.owner_account_id), "last_pay_method": last, "online_available": online_available(),
            "default_pay_method": owner_default_method(db, scope.owner_account_id)}


class DefaultUpiIn(BaseModel):
    upi_id: str = Field(max_length=80)
    otp_code: str | None = None


@router.put("/owner/upi-default")
def set_default_upi(body: DefaultUpiIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """The owner's UPI ID in the profile. Every tenant set to UPI (without an ID of their own) pays this one."""
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account owner can change the UPI ID")
    upi = _clean_upi(body.upi_id)
    if upi is None:
        raise AppError("VALIDATION", "enter your UPI ID", fields=[{"field": "pay_upi_id", "code": "upi_required"}])
    old = owner_default_upi(db, scope.owner_account_id)
    if upi != old:
        _approve_new_upi(db, scope, upi, body.otp_code)
        db.exec("UPDATE owner_accounts SET default_upi_id = :u WHERE id = :o", u=upi, o=scope.owner_account_id)
        db.audit(scope.user.id, scope.owner_account_id, "owner.default_upi_changed", "owner_account", scope.owner_account_id,
                 before={"default_upi_id": old}, after={"default_upi_id": upi})
        if old is not None:      # tenants who pay the profile UPI ID are told it changed
            owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
            for t in db.all("""SELECT id, tenant_user_id FROM tenancies WHERE owner_account_id = :o AND status = 'active' AND pay_method = 'upi'
                               AND pay_upi_id IS NULL AND tenant_user_id IS NOT NULL""", o=scope.owner_account_id):
                notify.enqueue(db, t["tenant_user_id"], "pay_method_changed", {"owner": owner_name, "unit": _unit_label(db, t["id"])},
                               f"paymethod:{t['id']}:{datetime.now().timestamp():.0f}", scope.owner_account_id)
    return {"upi_id": upi}


class PayMethodIn(BaseModel):
    method: Literal["upi", "online", "cash"]
    upi_id: str | None = Field(default=None, max_length=80)
    otp_code: str | None = None


@router.put("/owner/payment-method/unset")
def set_pay_method_for_unset(body: PayMethodIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """One choice for every live tenant that has no way of receiving rent chosen yet (tenants added before the choice existed).
    Tenants who already have a choice are left alone."""
    method, upi = resolve_pay_method(db, scope, body.method, body.upi_id, body.otp_code)
    n = db.scalar("""WITH u AS (UPDATE tenancies SET pay_method = :m, pay_upi_id = :u, updated_at = now()
                                WHERE owner_account_id = :o AND status IN ('invited','active') AND pay_method IS NULL RETURNING id)
                     SELECT count(*) FROM u""", m=method, u=upi, o=scope.owner_account_id)
    db.audit(scope.user.id, scope.owner_account_id, "owner.pay_method_set_for_unset", "owner_account", scope.owner_account_id,
             after={"pay_method": method, "pay_upi_id": upi, "tenants": n})
    return {"updated": n, "pay_method": method}


@router.put("/owner/tenancies/{tenancy_id}/payment-method")
def set_pay_method(tenancy_id: UUID, body: PayMethodIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    t = owned_tenancy(db, scope, tenancy_id, lock=True)
    if t["status"] not in ("invited", "active"):
        raise AppError("INVALID_STATE", "this rental has ended")
    default = owner_default_method(db, scope.owner_account_id)
    method, upi = resolve_pay_method(db, scope, body.method, body.upi_id, body.otp_code)
    if method == "online" and not online_available():
        raise AppError("VALIDATION", "online payment is not available yet", fields=[{"field": "pay_method", "code": "online_unavailable"}])
    stored = None if (upi is None and method == default) else method          # the same as the owner's usual way: follow it
    before_eff = t.get("pay_method") or default
    if (t.get("pay_method"), t.get("pay_upi_id")) != (stored, upi):
        db.exec("UPDATE tenancies SET pay_method = :m, pay_upi_id = :u, updated_at = now() WHERE id = :t", m=stored, u=upi, t=tenancy_id)
        db.audit(scope.user.id, scope.owner_account_id, "tenancy.pay_method_changed", "tenancy", tenancy_id,
                 before={"pay_method": t.get("pay_method"), "pay_upi_id": t.get("pay_upi_id")}, after={"pay_method": stored, "pay_upi_id": upi})
        if t["tenant_user_id"] and before_eff is not None and (before_eff != method or t.get("pay_upi_id") != upi):   # the tenant is told when the place they pay changes
            owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
            notify.enqueue(db, t["tenant_user_id"], "pay_method_changed", {"owner": owner_name, "unit": _unit_label(db, tenancy_id)},
                           f"paymethod:{tenancy_id}:{datetime.now().timestamp():.0f}", scope.owner_account_id)
    return {"pay_method": method, "pay_upi_id": upi, "follows_default": stored is None,
            "effective_upi_id": (upi or owner_default_upi(db, scope.owner_account_id)) if method == "upi" else None}


class DefaultMethodIn(BaseModel):
    method: Literal["upi", "online", "cash"]
    upi_id: str | None = Field(default=None, max_length=80)      # only when the profile has no UPI ID yet
    otp_code: str | None = None


@router.put("/owner/pay-default")
def set_default_method(body: DefaultMethodIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """The owner's usual way of receiving rent. Every tenant without a choice of their own follows it. For UPI the profile UPI ID is
    used; if there is none yet, the one given here (with a code) becomes the profile UPI ID."""
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account owner can change how rent is received")
    if body.method == "online" and not online_available():
        raise AppError("VALIDATION", "online payment is not available yet", fields=[{"field": "pay_method", "code": "online_unavailable"}])
    if body.method == "upi":
        upi, current = _clean_upi(body.upi_id), owner_default_upi(db, scope.owner_account_id)
        if upi is not None and current is not None and upi != current:
            raise AppError("VALIDATION", "change your UPI ID in the UPI ID box of your profile", fields=[{"field": "pay_upi_id", "code": "use_profile_upi"}])
        resolve_pay_method(db, scope, "upi", body.upi_id, body.otp_code)         # saves a first UPI ID as the profile one (needs the code)
    old = owner_default_method(db, scope.owner_account_id)
    if body.method != old:
        db.exec("UPDATE owner_accounts SET default_pay_method = :m WHERE id = :o", m=body.method, o=scope.owner_account_id)
        db.audit(scope.user.id, scope.owner_account_id, "owner.default_pay_method_changed", "owner_account", scope.owner_account_id,
                 before={"default_pay_method": old}, after={"default_pay_method": body.method})
        if old is not None:      # tenants who follow it are told
            owner_name = db.scalar("SELECT display_name FROM owner_accounts WHERE id = :o", o=scope.owner_account_id)
            for t in db.all("""SELECT id, tenant_user_id FROM tenancies WHERE owner_account_id = :o AND status = 'active'
                               AND pay_method IS NULL AND tenant_user_id IS NOT NULL""", o=scope.owner_account_id):
                notify.enqueue(db, t["tenant_user_id"], "pay_method_changed", {"owner": owner_name, "unit": _unit_label(db, t["id"])},
                               f"paymethod:{t['id']}:{datetime.now().timestamp():.0f}", scope.owner_account_id)
    return {"default_pay_method": body.method}


# ───────────────────────── tenant: manual transfer & online checkout ─────────────────────────
class TransferIn(BaseModel):
    amount: str | int
    paid_on: date
    reference: str = Field(min_length=4, max_length=40)
    idempotency_key: str = Field(min_length=8, max_length=80)


@router.post("/tenant/tenancies/{tenancy_id}/payments/manual-transfer")
def report_transfer(tenancy_id: UUID, body: TransferIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """A UPI/bank transfer made outside the app. Stays 'pending verification' — no effect on dues —
    until the owner confirms it against their bank statement."""
    t = tenant_tenancy(db, user, tenancy_id)
    amount = parse_inr(body.amount)
    ref = body.reference.strip()
    if not db.scalar("SELECT 1 FROM payments WHERE tenancy_id = :t AND idempotency_key = :k", t=tenancy_id, k=body.idempotency_key):
        _within_due(db, tenancy_id, amount, body.idempotency_key)
        # Serialise reports per owner until this transaction commits: without it two simultaneous requests (a double tap, two phones)
        # both pass the duplicate check below and the same reference is recorded twice.
        db.scalar("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))", k=f"utr:{t['owner_account_id']}")
        # the same UPI reference (UTR) cannot be used twice for one owner, and reports waiting for the owner count against what is due
        if db.scalar("""SELECT 1 FROM payment_events e JOIN payments p ON p.id = e.payment_id
                        WHERE p.owner_account_id = :o AND e.type = 'tenant_reference' AND lower(e.data->>'reference') = lower(:r)
                          AND p.status IN ('pending','confirmed')""", o=t["owner_account_id"], r=ref):
            raise AppError("VALIDATION", "this UPI reference number was already used for another payment",
                           fields=[{"field": "reference", "code": "duplicate_reference"}])
        waiting = db.scalar("""SELECT COALESCE(sum(amount_paise), 0) FROM payments WHERE tenancy_id = :t AND method = 'manual_transfer'
                               AND status = 'pending'""", t=tenancy_id) or 0
        due = max(db.scalar("SELECT payable_now_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id) or 0, 0)
        if amount + waiting > due:
            raise AppError("VALIDATION", f"you already reported {format_inr(waiting)} that the owner has not confirmed yet; "
                           f"together with this it is more than the due amount ({format_inr(due)})",
                           fields=[{"field": "amount", "code": "more_than_due"}], due_paise=due)
    pid = db.scalar("SELECT rg_record_payment(:t, 'manual_transfer', :a, :d, :k, :u)", t=tenancy_id, a=amount,
                    d=body.paid_on, k=body.idempotency_key, u=user.id)
    if not db.scalar("SELECT 1 FROM payment_events WHERE payment_id = :p AND type = 'tenant_reference'", p=pid):
        db.exec("INSERT INTO payment_events(payment_id, type, data) VALUES (:p, 'tenant_reference', CAST(:d AS jsonb))",
                p=pid, d=json.dumps({"reference": ref}))
        tenant_name = db.scalar("SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = :t ORDER BY created_at DESC LIMIT 1", t=tenancy_id) or "Your tenant"
        for uid in db.all("SELECT user_id FROM owner_memberships WHERE owner_account_id = :o AND status = 'active' AND role IN ('owner','co_owner')",
                          o=t["owner_account_id"]):
            notify.enqueue(db, uid["user_id"], "transfer_reported", {"tenant": tenant_name, "amount": format_inr(amount), "unit": _unit_label(db, tenancy_id)},
                           f"transfer-reported:{pid}:{uid['user_id']}", t["owner_account_id"])
    return _payment_out(db, pid)


class CheckoutIn(BaseModel):
    amount: str | int
    idempotency_key: str = Field(min_length=8, max_length=80)


def _checkout(db: Db, user: CurrentUser, tenancy_id: UUID, amount: int | None, key: str) -> dict:
    """One online payment for one rental. `amount=None` means the rental's full balance as the SERVER sees it."""
    s = get_settings()
    t = tenant_tenancy(db, user, tenancy_id)
    if (t.get("pay_method") or owner_default_method(db, t["owner_account_id"])) in ("upi", "cash"):
        raise AppError("PAYMENTS_UNAVAILABLE", "this owner collects rent directly (UPI or cash); online payment is not used for this rental")
    if not s.rent_online_enabled:
        raise AppError("PAYMENTS_UNAVAILABLE", "online payment is not available; pay the owner directly")
    payout = db.one("""SELECT provider_account_ref FROM payout_accounts WHERE owner_account_id = :o AND status = 'verified'""",
                    o=t["owner_account_id"])
    provider = get_provider("rent", s)
    if payout is None and not provider.is_demo:
        # Policy D-03: rent is never collected into the platform's own merchant account.
        raise AppError("PAYMENTS_UNAVAILABLE", "this owner has not set up online collection yet")
    if not provider.is_demo:
        from .kyc import owner_fully_verified
        if not owner_fully_verified(db, t["owner_account_id"]):        # real rent only goes to identity-verified, reviewed owners
            raise AppError("PAYMENTS_UNAVAILABLE", "this owner's identity has not been verified yet")
    existing = db.one("SELECT id, status FROM payments WHERE tenancy_id = :t AND idempotency_key = :k", t=tenancy_id, k=key)
    if existing:
        return _payment_out(db, existing["id"])
    if amount is None:
        amount = db.scalar("SELECT payable_now_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id) or 0
        if amount <= 0:
            raise AppError("VALIDATION", "nothing is due on this rental")
    else:
        _within_due(db, tenancy_id, amount, key)
    order = provider.create_order(amount_paise=amount, receipt=f"rent-{tenancy_id}"[:40], notes={"purpose": "rent", "tenancy": str(tenancy_id)},
                                  payee_account=payout["provider_account_ref"] if payout and not provider.is_demo else None)
    pid = db.scalar("SELECT rg_record_payment(:t, 'gateway', :a, :d, :k, :u, :pv, :po, :demo)", t=tenancy_id, a=amount, d=date.today(),
                    k=key, u=user.id, pv=provider.name, po=order.provider_order_id, demo=provider.is_demo)
    db.exec("UPDATE payments SET checkout = CAST(:c AS jsonb) WHERE id = :p", c=json.dumps(order.checkout), p=pid)
    return _payment_out(db, pid)


@router.post("/tenant/tenancies/{tenancy_id}/payments/checkout")
def online_checkout(tenancy_id: UUID, body: CheckoutIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    limiter.check(f"rentcheckout:{user.id}", 10, 600)
    return _checkout(db, user, tenancy_id, parse_inr(body.amount), body.idempotency_key)


class BulkItem(BaseModel):
    tenancy_id: UUID
    idempotency_key: str = Field(min_length=8, max_length=80)


class BulkCheckoutIn(BaseModel):
    items: list[BulkItem] = Field(min_length=1, max_length=20)


@router.post("/tenant/payments/checkout-bulk")
def bulk_checkout(body: BulkCheckoutIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """Pay several rentals in one go. Every rental is its own payment to its own owner for its FULL current balance (the server's
    figure, never the app's), with its own receipt. One rental failing does not stop the others."""
    limiter.check(f"rentbulk:{user.id}", 5, 600)
    if len({str(i.tenancy_id) for i in body.items}) != len(body.items):
        raise AppError("VALIDATION", "each rental can appear only once")
    out = []
    for it in body.items:
        try:
            out.append({"tenancy_id": str(it.tenancy_id), "payment": _checkout(db, user, it.tenancy_id, None, it.idempotency_key), "error": None})
        except AppError as e:
            out.append({"tenancy_id": str(it.tenancy_id), "payment": None, "error": {"code": e.code, "message": str(e)}})
    return {"items": out}


@router.post("/tenant/payments/{payment_id}/refresh")
def refresh_payment(payment_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    """'Check status' on the pending screen: server-to-server status check, never the client's word."""
    p = db.must("""SELECT p.* FROM payments p JOIN tenancies t ON t.id = p.tenancy_id
                   WHERE p.id = :p AND t.tenant_user_id = :u""", "payment", p=payment_id, u=user.id)
    if p["status"] == "pending" and p["method"] == "gateway":
        st = get_provider("rent", get_settings()).fetch_status(p["provider_order_id"])
        if st.status == "captured" and st.provider_payment_id:
            db.scalar("SELECT rg_confirm_gateway_payment(:o, :p, :a)", o=p["provider_order_id"], p=st.provider_payment_id, a=st.amount_paise)
    return _payment_out(db, payment_id)


def process_rent_event(db: Db, ev) -> str:  # noqa: ANN001 - called from subscriptions.ingest_webhook
    if not ev.provider_order_id:
        return "ignored_no_order"
    if ev.kind == "captured" and ev.provider_payment_id and ev.amount_paise is not None:
        result = db.scalar("SELECT rg_confirm_gateway_payment(:o, :p, :a)", o=ev.provider_order_id, p=ev.provider_payment_id, a=ev.amount_paise)
        if result == "confirmed":
            p = db.one("""SELECT p.id, p.amount_paise, t.tenant_user_id, t.owner_account_id, r.number FROM payments p
                          JOIN tenancies t ON t.id = p.tenancy_id LEFT JOIN receipts r ON r.payment_id = p.id
                          WHERE p.provider_order_id = :o""", o=ev.provider_order_id)
            unit = db.scalar("SELECT u.identifier FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id WHERE p.id = :p", p=p["id"])
            notify.enqueue(db, p["tenant_user_id"], "payment_received", {"amount": format_inr(p["amount_paise"]), "unit": unit,
                           "receipt": p["number"]}, f"paid:{p['id']}", p["owner_account_id"])
        return result
    if ev.kind == "failed":
        return db.scalar("SELECT rg_fail_gateway_payment(:o, 'provider_failed')", o=ev.provider_order_id)
    return f"recorded_{ev.kind}"


@router.post("/webhooks/payments/rent", include_in_schema=False)
async def rent_webhook(request: Request) -> dict:
    from .subscriptions import ingest_webhook
    return ingest_webhook("rent", await request.body(), {k.lower(): v for k, v in request.headers.items()})


class AckIn(BaseModel):
    response: Literal["acknowledged", "disputed"]
    reason: str | None = Field(default=None, max_length=250)


@router.post("/tenant/payments/{payment_id}/ack")
def ack_payment(payment_id: UUID, body: AckIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    p = db.must("""SELECT p.* FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.id = :p AND t.tenant_user_id = :u""",
                "payment", p=payment_id, u=user.id)
    if body.response == "disputed":
        if not body.reason:
            raise AppError("VALIDATION", "tell the owner what is wrong")
        db.exec("""INSERT INTO disputes(owner_account_id, tenancy_id, target_type, target_id, raised_by, reason)
                   VALUES (:o, :t, 'payment', :p, :u, :r)""", o=p["owner_account_id"], t=p["tenancy_id"], p=payment_id, u=user.id,
                r=validate_note(body.reason, "reason"))
    db.exec("UPDATE payments SET tenant_ack = :a WHERE id = :p", a=body.response, p=payment_id)
    db.exec("INSERT INTO payment_events(payment_id, type, data) VALUES (:p, :t, '{}')", p=payment_id, t=f"tenant_{body.response}")
    return _payment_out(db, payment_id)


@router.get("/payments/{payment_id}")
def get_payment(payment_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    tid = db.scalar("SELECT tenancy_id FROM payments WHERE id = :p", p=payment_id)
    if tid is None:
        raise AppError("NOT_FOUND", "payment not found")
    tenancy_party(db, user, tid)
    return _payment_out(db, payment_id)


@router.get("/receipts/{receipt_id}", response_class=HTMLResponse)
def receipt_html(receipt_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> str:
    tid = db.scalar("SELECT tenancy_id FROM receipts WHERE id = :r", r=receipt_id)
    if tid is None:
        raise AppError("NOT_FOUND", "receipt not found")
    tenancy_party(db, user, tid)
    from ..i18n.documents import render_receipt
    return render_receipt(db, receipt_id, user.language)


# ───────────────────────── deposits ─────────────────────────
class DepositIn(BaseModel):
    type: Literal["received", "applied_to_dues", "refund"]
    amount: str | int
    reason: str | None = Field(default=None, max_length=250)
    idempotency_key: str = Field(min_length=8, max_length=80)


def _within_deposit_limits(db: Db, tenancy_id: UUID, kind: str, amount: int, key: str) -> None:
    """A refund or adjustment cannot be more than the deposit held; an adjustment cannot be more than is due; the advance received
    cannot go past the advance agreed (when one is agreed). A retry of a transaction that is already recorded is not checked again."""
    if db.scalar("SELECT 1 FROM deposit_transactions WHERE tenancy_id = :t AND idempotency_key = :k", t=tenancy_id, k=key):
        return
    held = max(db.scalar("SELECT rg_deposit_held(:t)", t=tenancy_id) or 0, 0)
    if kind in ("refund", "applied_to_dues") and amount > held:
        raise AppError("VALIDATION", f"the amount cannot be more than the deposit held ({format_inr(held)})",
                       fields=[{"field": "amount", "code": "more_than_held"}], held_paise=held)
    if kind == "applied_to_dues":
        due = max(db.scalar("SELECT payable_now_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id) or 0, 0)
        if amount > due:
            raise AppError("VALIDATION", f"the amount cannot be more than the due amount ({format_inr(due)})",
                           fields=[{"field": "amount", "code": "more_than_due"}], due_paise=due)
    if kind == "received":
        agreed = db.scalar("SELECT agreed_paise FROM deposits WHERE tenancy_id = :t", t=tenancy_id) or 0
        if agreed > 0 and held + amount > agreed:
            raise AppError("VALIDATION", f"the advance received cannot be more than the advance agreed ({format_inr(agreed)}); {format_inr(max(agreed - held, 0))} is still to receive",
                           fields=[{"field": "amount", "code": "more_than_agreed"}], agreed_paise=agreed)


@router.post("/owner/tenancies/{tenancy_id}/deposit")
def deposit_txn(tenancy_id: UUID, body: DepositIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    t = owned_tenancy(db, scope, tenancy_id)
    amount = parse_inr(body.amount)
    if body.type != "received" and not body.reason:
        raise AppError("VALIDATION", "a reason is required for deposit adjustments and refunds")
    _within_deposit_limits(db, tenancy_id, body.type, amount, body.idempotency_key)
    did = db.scalar("SELECT rg_deposit_txn(:t, :ty, :a, :r, :k, :by)", t=tenancy_id, ty=body.type, a=amount, r=body.reason,
                    k=body.idempotency_key, by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, f"deposit.{body.type}", "deposit_txn", did, after={"amount_paise": amount, "reason": body.reason})
    out = deposit_view(db, tenancy_id)
    if t["tenant_user_id"]:
        notify.enqueue(db, t["tenant_user_id"], "deposit_changed", {"unit": _unit_label(db, tenancy_id),
                       "change": f"{body.type.replace('_', ' ')} {format_inr(amount)}", "amount": format_inr(out["held_paise"])},
                       f"deposit:{did}", scope.owner_account_id)
    return out


def deposit_view(db: Db, tenancy_id: UUID) -> dict:
    agreed = db.scalar("SELECT agreed_paise FROM deposits WHERE tenancy_id = :t", t=tenancy_id) or 0
    held = db.scalar("SELECT rg_deposit_held(:t)", t=tenancy_id)
    txns = db.all("""SELECT d.id, d.type, d.amount_paise, d.reason, d.created_at, r.number AS receipt
                     FROM deposit_transactions d LEFT JOIN receipts r ON r.deposit_txn_id = d.id
                     WHERE d.tenancy_id = :t ORDER BY d.created_at""", t=tenancy_id)
    return {"agreed_paise": agreed, "held_paise": held, "held_display": format_inr(held), "transactions": [dict(x) for x in txns]}


@router.get("/tenancies/{tenancy_id}/deposit")
def get_deposit(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db, scope="function")) -> dict:
    tenancy_party(db, user, tenancy_id)
    return deposit_view(db, tenancy_id)


# ───────────────────────── owner payout account (for online rent) ─────────────────────────
class PayoutIn(BaseModel):
    display_masked: str = Field(min_length=4, max_length=40)
    provider_account_ref: str | None = Field(default=None, max_length=80)
    otp_code: str | None = None          # the code sent to the account's own mobile


@router.post("/owner/payout-account")
def set_payout_account(body: PayoutIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db, scope="function")) -> dict:
    """Sensitive: requires a fresh OTP sign-in (step-up) and notifies the owner on every change.
    Raw bank/UPI details are entered on the PSP's onboarding, never stored here."""
    if scope.membership_role != "owner":
        raise AppError("FORBIDDEN", "only the account owner can change payout details")
    from .action_otp import require_action_otp
    require_action_otp(db, scope.user.id, "payout", body.otp_code)
    db.exec("UPDATE payout_accounts SET status = 'disabled' WHERE owner_account_id = :o AND status IN ('pending_psp','verified')",
            o=scope.owner_account_id)
    pid = db.scalar("""INSERT INTO payout_accounts(owner_account_id, provider, provider_account_ref, display_masked, status, created_by)
                       VALUES (:o, :p, :r, :d, 'pending_psp', :u) RETURNING id""", o=scope.owner_account_id, p=get_settings().rent_provider,
                    r=body.provider_account_ref, d=body.display_masked, u=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "payout_account.changed", "payout_account", pid)
    notify.security_event(db, scope.user.id, None, "payout_details_changed")
    return {"payout_account_id": str(pid), "status": "pending_psp"}
