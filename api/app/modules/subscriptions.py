"""Public pricing and owner subscription lifecycle (owner → platform money flow).

Activation happens ONLY in rg_activate_subscription, called after a signature-verified
webhook or an authoritative server-to-server status check. A client "success" callback
just moves the app to a 'confirming…' screen that polls GET /subscription.
"""
from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from ..core.auth import OwnerScope, owner_scope
from ..core.config import get_settings
from ..core.db import Db, get_db, transaction
from ..core.errors import AppError
from ..domain.money import format_inr
from ..providers.payments import SandboxProvider, get_provider
from .owner_numbers import CoOwnerIn

router = APIRouter(prefix="/api/v1", tags=["subscription"])


def _plan_view(r) -> dict:
    """A plan as the landing page shows it. The launch price (price_paise) is what is charged; the regular price is for comparison only,
    and the saving is worked out here from the two, so the screen can never show a percentage that does not match the prices."""
    d = dict(r, price_display=format_inr(r["price_paise"]))
    reg = r["regular_price_paise"]
    if reg and reg > r["price_paise"]:
        d["regular_price_display"] = format_inr(reg)
        d["saving_paise"] = reg - r["price_paise"]
        d["saving_percent"] = int((reg - r["price_paise"]) * 100 / reg + 0.5)      # whole percent, rounded half up
    else:
        d["regular_price_paise"] = d["regular_price_display"] = d["saving_paise"] = d["saving_percent"] = None
    return d


@router.get("/plans")
def list_plans(db: Db = Depends(get_db)) -> dict:
    """Public — no login. Prices are server-authoritative; the app never sends a price."""
    rows = db.all("""SELECT p.code, p.label, p.price_paise, p.regular_price_paise, p.currency, p.billing_period, p.max_units, p.max_properties, p.version,
                            e.ai_enabled, e.features AS ai_features, e.monthly_token_allowance AS ai_monthly_tokens,
                            e.voice_seconds_allowance AS ai_voice_seconds,
                            l.paid_units AS paid_message_units, l.email_messages AS email_messages
                     FROM subscription_plans p JOIN plan_ai_entitlements e ON e.plan_id = p.id
                     JOIN plan_message_limits l ON l.plan_id = p.id
                     WHERE p.status = 'active' ORDER BY p.sort_order""")
    return {"paid_by": "owner", "tenant_access": "free",
            "plans": [_plan_view(r) for r in rows]}


def _plan(db: Db, code: str) -> dict:
    return dict(db.must("SELECT * FROM subscription_plans WHERE code = :c AND status = 'active'", "plan", c=code))


def _properties_fit(db: Db, owner: UUID, plan: dict) -> None:
    """A plan covers a number of properties; an account that already holds more cannot move onto a plan that covers fewer.
    (Older multi-property accounts are left as they were.)"""
    if db.scalar("SELECT legacy_multi_property FROM owner_accounts WHERE id = :o", o=owner):
        return
    held = db.scalar("SELECT count(*) FROM properties WHERE owner_account_id = :o AND archived_at IS NULL AND verification_status <> 'rejected'", o=owner)
    if held > plan["max_properties"]:
        raise AppError("PROPERTY_CAPACITY_EXCEEDED", f"you have {held} properties; {plan['label']} covers {plan['max_properties']}. Choose a larger plan.",
                       fields=[{"field": "plan_code", "code": "too_many_properties"}])


def subscription_summary(db: Db, owner: UUID) -> dict:
    state = db.scalar("SELECT rg_owner_write_state(:o)", o=owner)
    cur = db.one("""SELECT s.id, s.plan_code, s.price_paise, s.max_units, s.status, s.period_start, s.period_end, s.grace_until,
                           s.cancel_at_period_end, s.is_demo, sp.code AS scheduled_downgrade_to
                    FROM owner_subscriptions s LEFT JOIN subscription_plans sp ON sp.id = s.scheduled_plan_id
                    WHERE s.owner_account_id = :o AND s.status IN ('active','grace')""", o=owner)
    sched = db.one("""SELECT plan_code, period_start, period_end FROM owner_subscriptions
                      WHERE owner_account_id = :o AND status = 'scheduled'""", o=owner)
    used = db.scalar("SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active'", o=owner)
    ai = db.one("""SELECT token_allowance, tokens_consumed, tokens_reserved, voice_seconds_allowance, voice_seconds_consumed,
                          period_end FROM ai_usage_balances WHERE subscription_id = :s""", s=cur["id"]) if cur else None
    return {
        "state": state,                  # active | grace | read_only | none
        "current": dict(cur) if cur else None,
        "scheduled_renewal": dict(sched) if sched else None,
        "first_month_free_available": not db.scalar("SELECT EXISTS (SELECT 1 FROM owner_subscriptions WHERE owner_account_id = :o)", o=owner),
        "units_used": used,
        "units_capacity": cur["max_units"] if cur else 0,
        "properties_capacity": db.scalar("SELECT rg_property_allowance(:o)", o=owner),
        "units_remaining": max(0, cur["max_units"] - used) if cur and state == "active" else 0,
        "ai": dict(ai, tokens_remaining=max(0, ai["token_allowance"] - ai["tokens_consumed"] - ai["tokens_reserved"])) if ai else None,
        "policy": {
            "grace_days": get_settings().grace_days,
            "after_grace": "read_only: view/export history, record received payments; no new units or charges",
            "upgrade": "full new-plan price; new monthly period starts at activation; AI usage this period carries over",
            "downgrade": "takes effect at next renewal and only if active units fit the smaller plan",
            "cancel": "no refund; access continues to period end, then grace",
        },
    }


@router.get("/subscription")
def get_subscription(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    return subscription_summary(db, scope.owner_account_id)


@router.get("/subscription/messages")
def message_allowance(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    from .notify import message_usage
    return message_usage(db, scope.owner_account_id)


class CheckoutIn(BaseModel):
    plan_code: Literal["starter", "growth", "business", "max"]
    idempotency_key: str = Field(min_length=8, max_length=80)
    co_owners: list[CoOwnerIn] | None = Field(default=None, max_length=5)   # the second owner (number + relationship), when buying
    otp_code: str | None = None                                            # needed when a second owner is entered


def _create_or_reuse_order(db: Db, scope: OwnerScope, plan: dict, purpose: str, idem: str) -> dict:
    s = get_settings()
    owner = scope.owner_account_id
    db.exec("SELECT 1 FROM owner_accounts WHERE id = :o FOR UPDATE", o=owner)  # serialise checkouts per owner
    same_key = db.one("SELECT * FROM subscription_orders WHERE owner_account_id = :o AND idempotency_key = :k", o=owner, k=idem)
    if same_key:
        return _order_out(same_key)
    open_order = db.one("""SELECT * FROM subscription_orders WHERE owner_account_id = :o AND plan_id = :p AND purpose = :pu
                           AND status = 'created'""", o=owner, p=plan["id"], pu=purpose)
    provider = get_provider("subscription", s)
    if open_order:
        # Retrying: ask the PSP first so a payment that already went through is never charged twice.
        st = provider.fetch_status(open_order["provider_order_id"])
        if st.status == "captured" and st.provider_payment_id:
            db.scalar("SELECT rg_activate_subscription(:o, :p, :a, 'status_check', :g)", o=open_order["id"],
                      p=st.provider_payment_id, a=st.amount_paise, g=s.grace_days)
            return _order_out(db.one("SELECT * FROM subscription_orders WHERE id = :i", i=open_order["id"]))
        if db.scalar("SELECT created_at > now() - interval '30 minutes' FROM subscription_orders WHERE id = :i", i=open_order["id"]):
            return _order_out(open_order)
        db.exec("UPDATE subscription_orders SET status = 'expired' WHERE id = :i", i=open_order["id"])
    oid = db.scalar("""INSERT INTO subscription_orders(owner_account_id, plan_id, purpose, amount_paise, provider, idempotency_key, is_demo)
                       VALUES (:o, :p, :pu, :a, :pv, :k, :d) RETURNING id""",
                    o=owner, p=plan["id"], pu=purpose, a=plan["price_paise"], pv=provider.name, k=idem, d=provider.is_demo)
    order = provider.create_order(amount_paise=plan["price_paise"], receipt=f"sub-{oid}",
                                  notes={"purpose": "subscription", "order": str(oid)}, payee_account=None)
    db.exec("UPDATE subscription_orders SET provider_order_id = :po, checkout = CAST(:c AS jsonb) WHERE id = :i",
            po=order.provider_order_id, c=json.dumps(order.checkout), i=oid)
    db.audit(scope.user.id, owner, "subscription.checkout_created", "subscription_order", oid,
             after={"plan": plan["code"], "purpose": purpose, "amount_paise": plan["price_paise"]})
    return _order_out(db.one("SELECT * FROM subscription_orders WHERE id = :i", i=oid))


def _order_out(o) -> dict:  # noqa: ANN001
    return {"order_id": str(o["id"]), "status": o["status"], "purpose": o["purpose"], "amount_paise": o["amount_paise"],
            "amount_display": format_inr(o["amount_paise"]), "checkout": o["checkout"], "demo": o["is_demo"]}


@router.post("/subscription/checkout")
def checkout(body: CheckoutIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    if scope.membership_role not in ("owner", "co_owner"):
        raise AppError("FORBIDDEN", "only the owner can manage the subscription")
    plan = _plan(db, body.plan_code)
    if body.co_owners is not None:
        from .action_otp import require_action_otp
        from .owner_numbers import set_owner_numbers
        if body.co_owners and scope.membership_role == "owner":
            require_action_otp(db, scope.user.id, "co_owner", body.otp_code)
        set_owner_numbers(db, scope, body.co_owners)
    state = db.scalar("SELECT rg_owner_write_state(:o)", o=scope.owner_account_id)
    cur = db.one("""SELECT s.*, p.max_units AS cur_max FROM owner_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
                    WHERE s.owner_account_id = :o AND s.status IN ('active','grace')""", o=scope.owner_account_id)
    if cur is None:
        purpose = "new"
        used = db.scalar("SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active'", o=scope.owner_account_id)
        if used > plan["max_units"]:
            raise AppError("UNIT_CAPACITY_EXCEEDED", f"you have {used} active units; choose a larger plan or archive units")
        _properties_fit(db, scope.owner_account_id, plan)
        # the first month of any plan is free, once per owner account: no payment, the plan starts now
        started = db.scalar("SELECT rg_start_free_month(:o, :p, :g, :d)", o=scope.owner_account_id, p=plan["id"], g=get_settings().grace_days,
                            d=get_settings().is_demo)
        if started == "started":
            db.audit(scope.user.id, scope.owner_account_id, "subscription.free_month_started", "owner_account", scope.owner_account_id, after={"plan": plan["code"]})
            return {"free_month": True, "status": "paid", "order_id": None, "plan": plan["code"], "state_before": state}
    elif plan["max_units"] > cur["cur_max"]:
        purpose = "upgrade"
    elif plan["id"] == cur["plan_id"] or plan["id"] == cur["scheduled_plan_id"]:
        purpose = "renewal"
        if db.scalar("SELECT 1 FROM owner_subscriptions WHERE owner_account_id = :o AND status = 'scheduled'", o=scope.owner_account_id):
            raise AppError("INVALID_STATE", "next period is already paid")
    else:
        raise AppError("INVALID_STATE", "to move to a smaller plan use change-plan; it applies at renewal")
    out = _create_or_reuse_order(db, scope, plan, purpose, body.idempotency_key)
    out["state_before"] = state
    return out


class RenewIn(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=80)


@router.post("/subscription/renew")
def renew(body: RenewIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    last = db.one("""SELECT s.plan_id, s.scheduled_plan_id FROM owner_subscriptions s WHERE s.owner_account_id = :o
                     AND s.status IN ('active','grace','expired','completed') ORDER BY s.period_end DESC LIMIT 1""", o=scope.owner_account_id)
    if last is None:
        raise AppError("INVALID_STATE", "no plan to renew; choose a plan")
    code = db.scalar("SELECT code FROM subscription_plans WHERE id = :p", p=last["scheduled_plan_id"] or last["plan_id"])
    return checkout(CheckoutIn(plan_code=code, idempotency_key=body.idempotency_key), scope, db)


class ChangePlanIn(CheckoutIn):
    pass


@router.post("/subscription/change-plan")
def change_plan(body: ChangePlanIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    plan = _plan(db, body.plan_code)
    cur = db.one("""SELECT s.*, p.max_units AS cur_max FROM owner_subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
                    WHERE s.owner_account_id = :o AND s.status IN ('active','grace') FOR UPDATE""", o=scope.owner_account_id)
    if cur is None or plan["max_units"] > cur["cur_max"]:
        return checkout(body, scope, db)
    used = db.scalar("SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active'", o=scope.owner_account_id)
    if used > plan["max_units"]:
        raise AppError("UNIT_CAPACITY_EXCEEDED", f"{used} active units do not fit {plan['label']} ({plan['max_units']})")
    _properties_fit(db, scope.owner_account_id, plan)
    db.exec("UPDATE owner_subscriptions SET scheduled_plan_id = :p, updated_at = now() WHERE id = :s",
            p=None if plan["id"] == cur["plan_id"] else plan["id"], s=cur["id"])
    db.exec("INSERT INTO subscription_events(owner_account_id, subscription_id, type, data) VALUES (:o, :s, 'downgrade_scheduled', CAST(:d AS jsonb))",
            o=scope.owner_account_id, s=cur["id"], d=json.dumps({"to": plan["code"]}))
    return subscription_summary(db, scope.owner_account_id)


@router.post("/subscription/cancel")
def cancel(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    n = db.exec("""UPDATE owner_subscriptions SET cancel_at_period_end = true, updated_at = now()
                   WHERE owner_account_id = :o AND status IN ('active','grace')""", o=scope.owner_account_id)
    if not n:
        raise AppError("INVALID_STATE", "no active subscription")
    db.exec("INSERT INTO subscription_events(owner_account_id, type) VALUES (:o, 'cancel_requested')", o=scope.owner_account_id)
    return subscription_summary(db, scope.owner_account_id)


@router.post("/subscription/orders/{order_id}/refresh")
def refresh_order(order_id: UUID, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Pending screen 'check again': authoritative server-to-server status check."""
    o = db.must("SELECT * FROM subscription_orders WHERE id = :i AND owner_account_id = :o", "order", i=order_id, o=scope.owner_account_id)
    if o["status"] == "created" and o["provider_order_id"]:
        st = get_provider("subscription", get_settings()).fetch_status(o["provider_order_id"])
        if st.status == "captured" and st.provider_payment_id:
            db.scalar("SELECT rg_activate_subscription(:o, :p, :a, 'status_check', :g)", o=o["id"], p=st.provider_payment_id,
                      a=st.amount_paise, g=get_settings().grace_days)
    o = db.one("SELECT * FROM subscription_orders WHERE id = :i", i=order_id)
    return {"order": _order_out(o), "subscription": subscription_summary(db, scope.owner_account_id)}


@router.get("/subscription/payments")
def sub_payments(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    return {"items": [dict(r) for r in db.all(
        """SELECT o.id AS order_id, o.purpose, o.amount_paise, o.status, o.created_at, o.paid_at, o.is_demo, p.code AS plan_code,
                  sp.provider_payment_id, sp.verified_via
           FROM subscription_orders o JOIN subscription_plans p ON p.id = o.plan_id
           LEFT JOIN subscription_payments sp ON sp.order_id = o.id
           WHERE o.owner_account_id = :o ORDER BY o.created_at DESC LIMIT 100""", o=scope.owner_account_id)]}


@router.get("/subscription/receipts")
def sub_receipts(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    return {"items": [dict(r) for r in db.all(
        """SELECT i.number, i.amount_paise, i.issued_at, s.plan_code, s.period_start, s.period_end, s.is_demo
           FROM subscription_invoices i JOIN owner_subscriptions s ON s.id = i.subscription_id
           WHERE i.owner_account_id = :o ORDER BY i.issued_at DESC""", o=scope.owner_account_id)]}


# ───────────────────────── webhook (subscription purpose ONLY) ─────────────────────────
def ingest_webhook(purpose: str, body: bytes, headers: dict[str, str]) -> dict:
    """Shared ingestion skeleton; processing is purpose-specific and looks orders up ONLY in
    that purpose's table, so a rent event can never activate a subscription and vice versa."""
    s = get_settings()
    provider = get_provider(purpose, s)
    try:
        ev = provider.verify_webhook(body, headers)
    except AppError:
        with transaction() as db:
            db.exec("""INSERT INTO webhook_events(provider, purpose, event_id, signature_valid, payload, result)
                       VALUES (:p, :pu, :e, false, '{}'::jsonb, 'rejected_signature') ON CONFLICT DO NOTHING""",
                    p=provider.name, pu=purpose, e="badsig:" + hashlib.sha256(body).hexdigest())
        raise
    with transaction() as db:
        inserted = db.scalar("""INSERT INTO webhook_events(provider, purpose, event_id, signature_valid, payload)
                                VALUES (:p, :pu, :e, true, CAST(:b AS jsonb)) ON CONFLICT DO NOTHING RETURNING id""",
                             p=provider.name, pu=purpose, e=ev.event_id, b=json.dumps(ev.raw))
        if inserted is None:
            return {"result": "duplicate_event"}
        if purpose == "subscription":
            result = _process_subscription_event(db, ev)
        else:
            from .payments import process_rent_event
            result = process_rent_event(db, ev)
        db.exec("UPDATE webhook_events SET result = :r, processed_at = now() WHERE id = :i", r=result, i=inserted)
        return {"result": result}


def _process_subscription_event(db: Db, ev) -> str:  # noqa: ANN001
    if not ev.provider_order_id:
        return "ignored_no_order"
    order = db.one("SELECT id FROM subscription_orders WHERE provider_order_id = :p", p=ev.provider_order_id)
    if order is None:
        return "unknown_order"
    if ev.kind == "captured" and ev.provider_payment_id and ev.amount_paise is not None:
        return db.scalar("SELECT rg_activate_subscription(:o, :p, :a, 'webhook', :g)", o=order["id"],
                         p=ev.provider_payment_id, a=ev.amount_paise, g=get_settings().grace_days)
    return f"recorded_{ev.kind}"


@router.post("/webhooks/payments/subscription", include_in_schema=False)
async def subscription_webhook(request: Request) -> dict:
    body = await request.body()
    return ingest_webhook("subscription", body, {k.lower(): v for k, v in request.headers.items()})


# ───────────────────────── sandbox checkout page (demo only) ─────────────────────────
@router.get("/sandbox/pay/{purpose}/{order_id}", include_in_schema=False, response_class=HTMLResponse)
def sandbox_page(purpose: Literal["subscription", "rent"], order_id: str, amount: int) -> str:
    if not get_settings().is_demo:
        raise AppError("NOT_FOUND")
    from .sandbox_ui import option, page
    rupees = format_inr(amount)
    what = "RentMeezy plan" if purpose == "subscription" else "Rent payment"
    body = (f'<div class="card center"><p class="sub">{what}</p><div class="amount">{rupees}</div>'
            '<div class="note">Demo checkout — no money moves. In the real app you would pay with UPI, card or net banking.</div></div>'
            '<form method="post" class="card"><h1 style="font-size:18px">Choose a demo result</h1>'
            + option("success", "ok", "✅", "Pay (simulate success)", "The payment succeeds")
            + option("failure", "bad", "❌", "Simulate failure", "The payment does not go through")
            + "</form>")
    return page("Demo checkout", body, "DEMO PAYMENT · no money moves")


@router.post("/sandbox/pay/{purpose}/{order_id}", include_in_schema=False, response_class=HTMLResponse)
async def sandbox_pay(purpose: Literal["subscription", "rent"], order_id: str, request: Request) -> str:
    s = get_settings()
    if not s.is_demo:
        raise AppError("NOT_FOUND")
    form = (await request.body()).decode()
    outcome = "success" if "outcome=success" in form else "failure"
    provider = get_provider(purpose, s)
    assert isinstance(provider, SandboxProvider)
    with transaction() as db:
        amount = db.scalar("SELECT amount_paise FROM subscription_orders WHERE provider_order_id = :p" if purpose == "subscription"
                           else "SELECT amount_paise FROM payments WHERE provider_order_id = :p", p=order_id)
    if amount is None:
        raise AppError("NOT_FOUND")
    body = provider.build_event(order_id, amount, outcome)
    # Delivered through the real webhook path, signature and all.
    result = ingest_webhook(purpose, body, {"x-razorpay-signature": provider.sign(body)})
    from .sandbox_ui import result as result_page
    ok = outcome == "success"
    return result_page(ok, "Payment confirmed" if ok else "Payment not completed",
                       f"Demo webhook delivered: {result['result']}. " + ("The app confirms with the server before showing success." if ok else "No money was taken."))
