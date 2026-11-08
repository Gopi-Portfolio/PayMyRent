"""Durable scheduled jobs. Triggered by EventBridge Scheduler (→ signed POST /api/v1/jobs/{name})
or the CLI (python -m jobs.runner <name>). Each run is recorded in job_runs with a UNIQUE
(job_name, run_key) so a retried or duplicated trigger never double-processes, and every
step is itself idempotent (unique invoice per month, dedupe keys on notifications)."""
from __future__ import annotations

import hmac
import json
from collections.abc import Callable
from datetime import date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Header

from ..core.config import get_settings
from ..core.db import transaction
from ..core.errors import AppError
from ..domain.money import format_inr
from ..domain.notifications import overdue_days, owner_notice, reminder_dedupe_key, reminder_offset_due
from ..domain.signatures import verify_token
from ..providers.payments import get_provider
from . import notify

router = APIRouter(prefix="/api/v1", tags=["jobs"])
IST = ZoneInfo("Asia/Kolkata")


def today_ist() -> date:
    return datetime.now(IST).date()


def job_generate_invoices() -> dict:
    """Every active tenancy gets every missing month up to this one (not only the current month), so a missed run
    or a tenancy that started in the past still shows its dues."""
    from .billing import backfill_invoices
    with transaction() as db:
        ids = [r["id"] for r in db.all("SELECT t.id FROM tenancies t WHERE t.status = 'active'")]
    made = 0
    for tid in ids:                                   # one transaction per tenancy: one failure doesn't block others
        with transaction() as db:
            made += backfill_invoices(db, tid, today_ist())
    return {"month": str(today_ist().replace(day=1)), "generated": made, "tenancies": len(ids)}


def job_send_reminders() -> dict:
    """Renter: 5 / 1 days before and on the due date, then EVERY day after it until paid. Owner: 5 days before, then on the first
    late day and weekly after. Fully paid invoices and closed tenancies are skipped (reminder rules decide the channels)."""
    today = today_ist()
    queued = 0
    with transaction() as db:
        rows = db.all("""SELECT v.invoice_id, v.tenancy_id, v.due_date, v.open_paise, t.tenant_user_id, t.owner_account_id, t.status,
                                u.identifier, r.offsets_days, r.channels, r.enabled, a.primary_user_id AS owner_user_id,
                                COALESCE((SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1), '') AS tenant_name
                         FROM v_invoice_status v JOIN tenancies t ON t.id = v.tenancy_id JOIN units u ON u.id = t.unit_id
                         JOIN owner_accounts a ON a.id = t.owner_account_id
                         JOIN reminder_rules r ON r.owner_account_id = t.owner_account_id
                         WHERE v.open_paise > 0 AND t.status = 'active' AND r.enabled""")
        for r in rows:
            active = r["status"] == "active"
            amount, due = format_inr(r["open_paise"]), r["due_date"].strftime("%d-%m-%Y")
            channels = tuple(r["channels"])
            off = reminder_offset_due(today, r["due_date"], list(r["offsets_days"]), r["open_paise"], active)
            late = overdue_days(today, r["due_date"], r["open_paise"], active)
            if off is not None and off <= 0:                       # before / on the due date
                notify.enqueue(db, r["tenant_user_id"], "rent_reminder", {"amount": amount, "unit": r["identifier"], "due_date": due},
                               reminder_dedupe_key(r["invoice_id"], off, "auto"), r["owner_account_id"], channels=channels)
                queued += 1
            elif late is not None:                                  # past the due date: a push every day until it is paid
                notify.enqueue(db, r["tenant_user_id"], "rent_overdue", {"amount": amount, "unit": r["identifier"], "due_date": due, "days": late},
                               f"overdue:{r['invoice_id']}:{late}", r["owner_account_id"], channels=channels)
                queued += 1
            note = owner_notice(today, r["due_date"], r["open_paise"], active)
            if note is not None and r["owner_user_id"]:
                kind, days = note
                notify.enqueue(db, r["owner_user_id"], "owner_rent_due_soon" if kind == "soon" else "owner_rent_overdue",
                               {"amount": amount, "unit": r["identifier"], "tenant": r["tenant_name"], "due_date": due, "days": days},
                               f"owner-{kind}:{r['invoice_id']}:{days}", r["owner_account_id"], channels=channels)
                queued += 1
    return {"reminders_queued": queued}


def job_dispatch_notifications() -> dict:
    with transaction() as db:
        return notify.dispatch_pending(db)


def job_subscription_lifecycle() -> dict:
    with transaction() as db:
        owners = [r["owner_account_id"] for r in db.all("SELECT DISTINCT owner_account_id FROM owner_subscriptions WHERE status IN ('active','grace')")]
    for o in owners:
        with transaction() as db:
            db.scalar("SELECT 1 FROM owner_accounts WHERE id = :o FOR UPDATE", o=o)
            db.exec("SELECT rg_refresh_subscription(:o)", o=o)
            s = db.one("""SELECT s.id, s.plan_code, s.period_end, s.cancel_at_period_end, a.primary_user_id FROM owner_subscriptions s
                          JOIN owner_accounts a ON a.id = s.owner_account_id WHERE s.owner_account_id = :o AND s.status = 'active'
                          AND s.period_end < now() + interval '3 days'
                          AND NOT EXISTS (SELECT 1 FROM owner_subscriptions x WHERE x.owner_account_id = :o AND x.status = 'scheduled')""", o=o)
            if s:
                notify.enqueue(db, s["primary_user_id"], "subscription_expiring",
                               {"plan": s["plan_code"].title(), "due_date": s["period_end"].astimezone(IST).strftime("%d-%m-%Y")},
                               f"sub-expiring:{s['id']}", o)
    return {"owners_checked": len(owners)}


def job_reconcile_payments() -> dict:
    """Catch payments whose webhook never arrived: authoritative status check with the PSP."""
    s = get_settings()
    out = {"rent_confirmed": 0, "sub_activated": 0, "stale_failed": 0}
    with transaction() as db:
        pending = db.all("""SELECT provider_order_id FROM payments WHERE method = 'gateway' AND status = 'pending'
                            AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '3 days' LIMIT 200""")
        orders = db.all("""SELECT id, provider_order_id FROM subscription_orders WHERE status = 'created' AND provider_order_id IS NOT NULL
                           AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '3 days' LIMIT 200""")
    run_key = today_ist().isoformat()
    for p in pending:
        st = get_provider("rent", s).fetch_status(p["provider_order_id"])
        with transaction() as db:
            if st.status == "captured" and st.provider_payment_id:
                r = db.scalar("SELECT rg_confirm_gateway_payment(:o, :p, :a)", o=p["provider_order_id"], p=st.provider_payment_id, a=st.amount_paise)
                out["rent_confirmed"] += r == "confirmed"
                db.exec("""INSERT INTO reconciliation_records(run_key, provider, purpose, provider_payment_id, provider_amount_paise, status)
                           VALUES (:k, :pv, 'rent', :p, :a, 'matched') ON CONFLICT DO NOTHING""", k=run_key, pv=s.rent_provider,
                        p=st.provider_payment_id, a=st.amount_paise)
            elif st.status == "failed":
                db.scalar("SELECT rg_fail_gateway_payment(:o, 'reconciled_failed')", o=p["provider_order_id"])
                out["stale_failed"] += 1
    for o in orders:
        st = get_provider("subscription", s).fetch_status(o["provider_order_id"])
        if st.status == "captured" and st.provider_payment_id:
            with transaction() as db:
                r = db.scalar("SELECT rg_activate_subscription(:o, :p, :a, 'status_check', :g)", o=o["id"], p=st.provider_payment_id,
                              a=st.amount_paise, g=s.grace_days)
                out["sub_activated"] += r == "activated"
    with transaction() as db:
        db.exec("""UPDATE subscription_orders SET status = 'expired' WHERE status = 'created' AND created_at < now() - interval '3 days'""")
    return out


JOBS: dict[str, Callable[[], dict]] = {
    "generate_invoices": job_generate_invoices,
    "send_reminders": job_send_reminders,
    "dispatch_notifications": job_dispatch_notifications,
    "subscription_lifecycle": job_subscription_lifecycle,
    "reconcile_payments": job_reconcile_payments,
}


def run_job(name: str, run_key: str) -> dict:
    if name not in JOBS:
        raise AppError("NOT_FOUND", "unknown job")
    with transaction() as db:
        claimed = db.scalar("""INSERT INTO job_runs(job_name, run_key) VALUES (:n, :k)
                               ON CONFLICT (job_name, run_key) DO UPDATE SET status = 'running', started_at = now()
                               WHERE job_runs.status = 'failed' RETURNING id""", n=name, k=run_key)
    if claimed is None:
        return {"job": name, "run_key": run_key, "status": "already_ran_or_running"}
    try:
        detail = JOBS[name]()
        status = "succeeded"
    except Exception as e:  # noqa: BLE001
        detail, status = {"error": type(e).__name__}, "failed"
    with transaction() as db:
        db.exec("UPDATE job_runs SET status = :s, detail = CAST(:d AS jsonb), finished_at = now() WHERE id = :i",
                s=status, d=json.dumps(detail, default=str), i=claimed)
    return {"job": name, "run_key": run_key, "status": status, "detail": detail}


def default_run_key(name: str) -> str:
    now = datetime.now(IST)
    if name in ("dispatch_notifications", "reconcile_payments"):
        return now.strftime("%Y-%m-%dT%H:") + f"{now.minute // 15 * 15:02d}"
    if name == "subscription_lifecycle":
        return now.strftime("%Y-%m-%dT%H")
    return now.date().isoformat()


@router.post("/jobs/{name}", include_in_schema=False)
def trigger_job(name: str, run_key: str | None = None, x_job_key: str | None = Header(default=None),
                x_job_token: str | None = Header(default=None)) -> dict:
    """Called by an EventBridge rule → API destination (connection auth sends X-Job-Key), or by
    an operator with a short-lived signed X-Job-Token. The run key defaults to the IST date /
    time bucket, so duplicate deliveries inside a bucket are no-ops via job_runs."""
    secret = get_settings().job_trigger_secret
    ok = bool(x_job_key) and hmac.compare_digest(x_job_key, secret)
    if not ok and x_job_token:
        claims = verify_token(secret, x_job_token)
        ok = bool(claims) and claims.get("job") in (name, "*")
    if not ok:
        raise AppError("FORBIDDEN", "bad job credentials")
    return run_job(name, run_key or default_run_key(name))


@router.get("/health", tags=["admin"])
def health() -> dict:
    with transaction() as db:
        db.scalar("SELECT 1")
        last = {r["job_name"]: r["finished_at"] for r in db.all(
            "SELECT DISTINCT ON (job_name) job_name, finished_at FROM job_runs WHERE status = 'succeeded' ORDER BY job_name, finished_at DESC")}
    return {"status": "ok", "env": get_settings().app_env, "last_job_success": last}


@router.get("/meta/validation", tags=["admin"])
def validation_rules() -> dict:
    from ..domain.validation import FIELD_RULES
    return {"fields": [r.__dict__ for r in FIELD_RULES]}

