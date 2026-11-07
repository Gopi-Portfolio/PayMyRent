"""Monthly bills, owner charges, tenant charge submissions, adjustments, history, dashboard,
statements. All amounts come from SQL; nothing here does arithmetic on money except sums
of integer paise for presentation."""
from __future__ import annotations

import csv
import io
import re
from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, Field

from ..core.auth import CurrentUser, OwnerScope, complete_user, owned_tenancy, owner_scope, tenancy_party
from ..core.db import Db, get_db
from ..core.errors import AppError
from ..domain.money import format_inr, parse_inr
from . import notify
from ..domain.places import floor_name
from .relief import month_relief

router = APIRouter(prefix="/api/v1", tags=["billing"])
Category = Literal["electricity", "water", "maintenance", "misc"]


def _month(m: date | None) -> date:
    return (m or date.today()).replace(day=1)


def backfill_invoices(db: Db, tenancy_id: UUID, upto: date | None = None) -> int:
    """Create every missing monthly bill from the tenancy start month up to `upto` (default: this month). Idempotent:
    rg_generate_monthly_invoice posts a month's rent once. Without this, a month that was never billed shows no dues at all."""
    t = db.one("SELECT start_date, status FROM tenancies WHERE id = :t", t=tenancy_id)
    if not t or t["status"] != "active":
        return 0
    last = _month(upto or date.today())
    m = t["start_date"].replace(day=1)
    made = 0
    while m <= last and made < 60:                      # at most 5 years in one catch-up
        if db.scalar("SELECT rg_generate_monthly_invoice(:t, :m)", t=tenancy_id, m=m):
            made += 1
        m = date(m.year + (m.month // 12), m.month % 12 + 1, 1)
    return made


def bill_view(db: Db, tenancy_id: UUID, month: date, role: str) -> dict:
    inv = db.one("SELECT * FROM v_invoice_status WHERE tenancy_id = :t AND period_month = :m", t=tenancy_id, m=month)
    lines = db.all("""SELECT l.id, l.category, l.kind, l.description, l.amount_paise, l.source, l.reason, l.created_at,
                             COALESCE(o.open_paise, 0) AS open_paise
                      FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id
                      LEFT JOIN v_line_open o ON o.line_id = l.id
                      WHERE i.tenancy_id = :t AND i.period_month = :m ORDER BY rg_category_priority(l.category), l.created_at""",
                   t=tenancy_id, m=month)
    arrears = db.scalar("SELECT COALESCE(sum(open_paise), 0) FROM v_invoice_status WHERE tenancy_id = :t AND period_month < :m",
                        t=tenancy_id, m=month)
    later = db.scalar("SELECT COALESCE(sum(open_paise), 0) FROM v_invoice_status WHERE tenancy_id = :t AND period_month > :m",
                      t=tenancy_id, m=month)
    credit = db.scalar("""SELECT COALESCE(sum(remaining_paise), 0) FROM v_payment_remaining WHERE tenancy_id = :t""", t=tenancy_id) \
        + db.scalar("SELECT COALESCE(sum(remaining_paise), 0) FROM v_credit_remaining WHERE tenancy_id = :t", t=tenancy_id)
    balance = db.scalar("SELECT balance_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id)
    payable_now = db.scalar("SELECT payable_now_paise FROM v_tenancy_balance WHERE tenancy_id = :t", t=tenancy_id)
    pending_subs = db.all("""SELECT id, category, amount_paise, reading_previous, reading_current, status, submitter_role, created_at
                             FROM charge_submissions WHERE tenancy_id = :t AND period_month = :m ORDER BY created_at""", t=tenancy_id, m=month)
    month_charges = sum(line["amount_paise"] for line in lines)
    month_open = inv["open_paise"] if inv else 0
    total_due = arrears + month_open + later - credit
    if total_due != balance:  # presentation must reconcile with the ledger; never show a number that doesn't
        raise AppError("CONFLICT", "bill does not reconcile with ledger; please retry")
    return {
        "period_month": month.isoformat(), "invoice_number": inv["number"] if inv else None,
        "due_date": inv["due_date"].isoformat() if inv else None, "status": inv["status"] if inv else "no_bill",
        "lines": [dict(r) for r in lines],
        "summary": {"arrears_paise": arrears, "this_month_charges_paise": month_charges,
                    "paid_towards_this_month_paise": month_charges - month_open if inv else 0,
                    "this_month_open_paise": month_open, "later_months_open_paise": later, "advance_credit_paise": credit,
                    "total_due_paise": balance, "total_due_display": format_inr(balance),
                    "payable_now_paise": payable_now, "payable_now_display": format_inr(payable_now)},   # owed vs. payable this month (a carried-over balance is owed, not yet payable)
        "relief": month_relief(db, tenancy_id, month),
        "submissions": [dict(s) for s in pending_subs],
        "viewer_role": role,
    }


@router.get("/tenancies/{tenancy_id}/bill")
def get_bill(tenancy_id: UUID, month: date | None = None, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    _, role, _ = tenancy_party(db, user, tenancy_id)
    return bill_view(db, tenancy_id, _month(month), role)


@router.get("/tenancies/{tenancy_id}/history")
def history(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    tenancy_party(db, user, tenancy_id)
    months = db.all("""SELECT period_month, number, due_date, total_paise, open_paise, status FROM v_invoice_status
                       WHERE tenancy_id = :t ORDER BY period_month DESC LIMIT 120""", t=tenancy_id)
    pays = db.all("""SELECT p.id, p.method, p.verification, p.status, p.amount_paise, p.paid_on, p.tenant_ack, p.is_demo, r.number AS receipt
                     FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id
                     WHERE p.tenancy_id = :t ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 200""", t=tenancy_id)
    return {"months": [dict(m) for m in months], "payments": [dict(p) for p in pays]}


class ChargeIn(BaseModel):
    period_month: date
    category: Literal["electricity", "water", "maintenance", "misc", "other"]
    amount: str | int
    description: str | None = Field(default=None, max_length=120)


@router.post("/owner/tenancies/{tenancy_id}/charges")
def add_charge(tenancy_id: UUID, body: ChargeIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    owned_tenancy(db, scope, tenancy_id)
    amount = parse_inr(body.amount)
    line = db.scalar("SELECT rg_add_charge(:t, :m, :c, :a, :d, :by)", t=tenancy_id, m=_month(body.period_month), c=body.category,
                     a=amount, d=body.description or body.category.title(), by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "charge.added", "invoice_line", line, after={"amount_paise": amount, "category": body.category})
    return bill_view(db, tenancy_id, _month(body.period_month), "owner")


@router.get("/owner/tenancies/{tenancy_id}/charge-suggestions")
def charge_suggestions(tenancy_id: UUID, month: date, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    """Last month's utility amounts as *editable suggestions* — never billed automatically."""
    owned_tenancy(db, scope, tenancy_id)
    prev = (_month(month) - timedelta(days=1)).replace(day=1)
    rows = db.all("""SELECT l.category, sum(l.amount_paise) AS amount_paise FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id
                     WHERE i.tenancy_id = :t AND i.period_month = :p AND l.category IN ('electricity','water','misc','maintenance')
                     GROUP BY l.category""", t=tenancy_id, p=prev)
    cfg = db.all("SELECT category FROM recurring_charge_config WHERE tenancy_id = :t AND enabled", t=tenancy_id)
    enabled = {c["category"] for c in cfg}
    return {"month": _month(month).isoformat(), "suggestions": [dict(r, editable=True) for r in rows if r["category"] in enabled]}


class AdjustIn(BaseModel):
    new_total: str | int
    reason: str = Field(min_length=3, max_length=250)


@router.post("/owner/invoice-lines/{line_id}/adjust")
def adjust_line(line_id: UUID, body: AdjustIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    row = db.must("""SELECT i.tenancy_id, i.period_month FROM invoice_lines l JOIN monthly_invoices i ON i.id = l.invoice_id
                     WHERE l.id = :l AND i.owner_account_id = :o""", "line", l=line_id, o=scope.owner_account_id)
    new = db.scalar("SELECT rg_adjust_line(:l, :a, :r, :by)", l=line_id, a=parse_inr(body.new_total, allow_zero=True), r=body.reason, by=scope.user.id)
    db.audit(scope.user.id, scope.owner_account_id, "charge.adjusted", "invoice_line", line_id, after={"adjustment_line": str(new) if new else None})
    return bill_view(db, row["tenancy_id"], row["period_month"], "owner")


@router.post("/owner/tenancies/{tenancy_id}/invoices")
def generate_invoice(tenancy_id: UUID, month: date, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    owned_tenancy(db, scope, tenancy_id)
    backfill_invoices(db, tenancy_id, _month(month))      # earlier unbilled months become dues too
    return bill_view(db, tenancy_id, _month(month), "owner")


# ───────────────────────── tenant-proposed readings / amounts ─────────────────────────
class SubmissionIn(BaseModel):
    period_month: date
    category: Category
    amount: str | int
    reading_previous: float | None = Field(default=None, ge=0)
    reading_current: float | None = Field(default=None, ge=0)
    attachment_id: UUID | None = None


@router.post("/tenancies/{tenancy_id}/charge-submissions")
def submit_charge(tenancy_id: UUID, body: SubmissionIn, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    t, role, _ = tenancy_party(db, user, tenancy_id)
    if role != "tenant":
        raise AppError("FORBIDDEN", "owners add charges directly")
    if t["status"] != "active":
        raise AppError("TENANCY_NOT_ACTIVE")
    cfg = db.one("SELECT enabled, tenant_can_submit FROM recurring_charge_config WHERE tenancy_id = :t AND category = :c",
                 t=tenancy_id, c=body.category)
    if not cfg or not cfg["enabled"] or not cfg["tenant_can_submit"]:
        raise AppError("FORBIDDEN", "this charge type is not open for tenant entry")
    if body.reading_previous is not None and body.reading_current is not None and body.reading_current < body.reading_previous:
        raise AppError("VALIDATION", "current reading cannot be lower than previous")
    if body.attachment_id:
        db.must("SELECT 1 FROM file_attachments WHERE id = :a AND uploaded_by = :u", "attachment", a=body.attachment_id, u=user.id)
    sid = db.scalar("""INSERT INTO charge_submissions(tenancy_id, period_month, category, reading_previous, reading_current, amount_paise,
                                                      submitted_by, submitter_role, attachment_id)
                       VALUES (:t, :m, :c, :rp, :rc, :a, :u, 'tenant', :att) RETURNING id""",
                    t=tenancy_id, m=_month(body.period_month), c=body.category, rp=body.reading_previous, rc=body.reading_current,
                    a=parse_inr(body.amount), u=user.id, att=body.attachment_id)
    db.audit(user.id, t["owner_account_id"], "charge_submission.created", "charge_submission", sid)
    return {"submission_id": str(sid), "status": "proposed", "note": "Not payable until the owner approves."}


class ReviewIn(BaseModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=250)


@router.get("/owner/charge-submissions")
def pending_submissions(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    return {"items": [dict(r) for r in db.all(
        """SELECT s.*, u.identifier FROM charge_submissions s JOIN tenancies t ON t.id = s.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE t.owner_account_id = :o AND s.status = 'proposed' ORDER BY s.created_at""", o=scope.owner_account_id)]}


@router.post("/owner/charge-submissions/{submission_id}/review")
def review_submission(submission_id: UUID, body: ReviewIn, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    s = db.must("""SELECT s.*, t.tenant_user_id, u.identifier FROM charge_submissions s JOIN tenancies t ON t.id = s.tenancy_id
                   JOIN units u ON u.id = t.unit_id WHERE s.id = :s AND t.owner_account_id = :o""", "submission", s=submission_id, o=scope.owner_account_id)
    db.scalar("SELECT rg_review_charge_submission(:s, :by, :a, :r)", s=submission_id, by=scope.user.id, a=body.approve, r=body.reason)
    db.audit(scope.user.id, scope.owner_account_id, "charge_submission.reviewed", "charge_submission", submission_id, after=body.model_dump())
    notify.enqueue(db, s["tenant_user_id"], "charge_reviewed", {"category": s["category"], "amount": format_inr(s["amount_paise"]),
                   "unit": s["identifier"], "decision": "approved" if body.approve else "rejected"}, f"review:{submission_id}",
                   scope.owner_account_id, channels=("push",))
    return bill_view(db, s["tenancy_id"], s["period_month"], "owner")


# ───────────────────────── dashboard & reports ─────────────────────────
@router.get("/owner/dashboard")
def dashboard(scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> dict:
    o = scope.owner_account_id
    m = db.one("""SELECT
        (SELECT COALESCE(sum(amount_paise), 0) FROM payments WHERE owner_account_id = :o AND status = 'confirmed' AND method <> 'deposit'
           AND paid_on >= date_trunc('month', rg_today())) AS collected_paise,
        (SELECT COALESCE(sum(GREATEST(balance_paise, 0)), 0) FROM v_tenancy_balance WHERE owner_account_id = :o) AS pending_paise,
        (SELECT COALESCE(sum(open_paise), 0) FROM v_invoice_status WHERE owner_account_id = :o AND due_date < rg_today()) AS overdue_paise,
        (SELECT count(DISTINCT tenancy_id) FROM v_invoice_status WHERE owner_account_id = :o AND due_date < rg_today() AND open_paise > 0) AS overdue_tenants,
        (SELECT COALESCE(sum(p.amount_paise), 0) FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE p.owner_account_id = :o AND p.status = 'confirmed' AND p.method <> 'deposit' AND p.paid_on >= date_trunc('month', rg_today()) AND u.kind = 'residential') AS collected_residential_paise,
        (SELECT COALESCE(sum(p.amount_paise), 0) FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE p.owner_account_id = :o AND p.status = 'confirmed' AND p.method <> 'deposit' AND p.paid_on >= date_trunc('month', rg_today()) AND u.kind = 'commercial') AS collected_commercial_paise,
        (SELECT COALESCE(sum(GREATEST(b.balance_paise, 0)), 0) FROM v_tenancy_balance b JOIN tenancies t ON t.id = b.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE b.owner_account_id = :o AND u.kind = 'residential') AS pending_residential_paise,
        (SELECT COALESCE(sum(GREATEST(b.balance_paise, 0)), 0) FROM v_tenancy_balance b JOIN tenancies t ON t.id = b.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE b.owner_account_id = :o AND u.kind = 'commercial') AS pending_commercial_paise,
        (SELECT COALESCE(sum(v.open_paise), 0) FROM v_invoice_status v JOIN tenancies t ON t.id = v.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE v.owner_account_id = :o AND v.due_date < rg_today() AND u.kind = 'residential') AS overdue_residential_paise,
        (SELECT COALESCE(sum(v.open_paise), 0) FROM v_invoice_status v JOIN tenancies t ON t.id = v.tenancy_id JOIN units u ON u.id = t.unit_id
           WHERE v.owner_account_id = :o AND v.due_date < rg_today() AND u.kind = 'commercial') AS overdue_commercial_paise,
        (SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active') AS units,
        (SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active' AND kind = 'residential') AS residential,
        (SELECT count(*) FROM units WHERE owner_account_id = :o AND status = 'active' AND kind = 'commercial') AS commercial,
        (SELECT count(*) FROM charge_submissions s JOIN tenancies t ON t.id = s.tenancy_id WHERE t.owner_account_id = :o AND s.status = 'proposed') AS approvals_pending,
        (SELECT count(*) FROM disputes WHERE owner_account_id = :o AND status = 'open') AS disputes_open,
        (SELECT count(*) FROM rent_relief WHERE owner_account_id = :o AND status = 'requested') AS relief_pending,
        (SELECT count(*) FROM vacate_requests WHERE owner_account_id = :o AND status = 'requested') AS vacate_pending""", o=o)
    from .subscriptions import subscription_summary
    sub = subscription_summary(db, o)
    return {"metrics": {k: (dict(value=v, display=format_inr(v)) if k.endswith("_paise") else v) for k, v in dict(m).items()},
            "subscription": {"state": sub["state"], "plan": (sub["current"] or {}).get("plan_code"),
                             "units_capacity": sub["units_capacity"], "units_remaining": sub["units_remaining"],
                             "period_end": (sub["current"] or {}).get("period_end")}}


@router.get("/owner/dashboard/{kind}")
def dashboard_detail(kind: Literal["collected", "pending", "overdue", "units"], scope: OwnerScope = Depends(owner_scope),
                     db: Db = Depends(get_db)) -> dict:
    """The rows behind each dashboard box, so a tap shows exactly what makes up the number."""
    o = scope.owner_account_id
    who = "(SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1)"
    if kind == "collected":
        rows = db.all(f"""SELECT p.id, p.paid_on, p.method, p.amount_paise, u.identifier, {who} AS tenant_name, t.id AS tenancy_id
                          FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
                          WHERE p.owner_account_id = :o AND p.status = 'confirmed' AND p.method <> 'deposit'
                            AND p.paid_on >= date_trunc('month', rg_today()) ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 300""", o=o)
    elif kind == "pending":
        rows = db.all(f"""SELECT t.id AS tenancy_id, u.identifier, {who} AS tenant_name, b.balance_paise AS amount_paise,
                                 (SELECT min(v.due_date) FROM v_invoice_status v WHERE v.tenancy_id = t.id AND v.open_paise > 0) AS oldest_due,
                                 (SELECT count(*) FROM v_invoice_status v WHERE v.tenancy_id = t.id AND v.open_paise > 0) AS open_months
                          FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                          WHERE t.owner_account_id = :o AND b.balance_paise > 0 ORDER BY b.balance_paise DESC LIMIT 300""", o=o)
    elif kind == "overdue":
        rows = db.all(f"""SELECT v.invoice_id AS id, v.tenancy_id, v.period_month, v.due_date, v.open_paise AS amount_paise, u.identifier,
                                 {who} AS tenant_name, (rg_today() - v.due_date) AS days_overdue
                          FROM v_invoice_status v JOIN tenancies t ON t.id = v.tenancy_id JOIN units u ON u.id = t.unit_id
                          WHERE v.owner_account_id = :o AND v.due_date < rg_today() AND v.open_paise > 0
                          ORDER BY v.due_date, u.identifier LIMIT 300""", o=o)
    else:
        rows = db.all(f"""SELECT u.id, u.identifier, u.kind, u.floor, p.name AS property_name, p.address, t.id AS tenancy_id, t.status AS tenancy_status,
                                 t.monthly_rent_paise AS amount_paise, {who} AS tenant_name
                          FROM units u JOIN properties p ON p.id = u.property_id
                          LEFT JOIN tenancies t ON t.unit_id = u.id AND t.status IN ('invited','active')
                          WHERE u.owner_account_id = :o AND u.status = 'active' ORDER BY p.name, u.identifier LIMIT 300""", o=o)
    items = [dict(r) for r in rows]
    total = sum(int(r.get("amount_paise") or 0) for r in items) if kind != "units" else None
    return {"kind": kind, "items": items, "total_paise": total, "total_display": format_inr(total) if total is not None else None}


@router.get("/owner/reports/collections.csv")
def collections_csv(start: date, end: date, scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> Response:
    """Export works in every subscription state, including read-only after lapse."""
    rows = db.all("""SELECT p.paid_on, u.identifier, s.name AS tenant, p.method, p.verification, p.status, p.amount_paise, r.number AS receipt
                     FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
                     LEFT JOIN receipts r ON r.payment_id = p.id
                     LEFT JOIN LATERAL (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) s ON true
                     WHERE p.owner_account_id = :o AND p.paid_on BETWEEN :a AND :b ORDER BY p.paid_on""", o=scope.owner_account_id, a=start, b=end)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["date", "unit", "tenant", "method", "verification", "status", "amount_inr", "receipt"])
    for r in rows:
        # CSV-injection safe: prefix cells that a spreadsheet would treat as formulas
        cells = [r["paid_on"], r["identifier"], r["tenant"], r["method"], r["verification"], r["status"],
                 f"{r['amount_paise'] // 100}.{r['amount_paise'] % 100:02d}", r["receipt"]]
        w.writerow(["'" + c if isinstance(c, str) and c[:1] in "=+-@" else c for c in cells])
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=collections.csv"})


def _file(name: str, fmt: str, title: str, subtitle: str, tables: list) -> Response:
    """One Excel or PDF download. The file name is ASCII; the content carries the real names."""
    from ..domain import report_files as rf
    if fmt == "xlsx":
        data, mime = rf.make_xlsx(title, subtitle, tables), rf.XLSX
    else:
        try:
            data, mime = rf.make_pdf(title, subtitle, tables), rf.PDF
        except ImportError:
            raise AppError("PDF_UNAVAILABLE", "PDF is not available on this server right now. Download the Excel file instead.", status=503) from None
    return Response(data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}.{fmt}"', "Cache-Control": "no-store"})


@router.get("/owner/dashboard/{kind}/export")
def dashboard_export(kind: Literal["collected", "pending", "overdue", "units"], fmt: Literal["xlsx", "pdf"] = Query("xlsx", alias="format"),
                     scope: OwnerScope = Depends(owner_scope), db: Db = Depends(get_db)) -> Response:
    """The rows behind a home-screen box as an Excel sheet or PDF. Works in every subscription state."""
    d = dashboard_detail(kind, scope, db)
    items = d["items"]
    today = date.today()
    if kind == "collected":
        head = ["Date", "Unit", "Renter", "Method", "Amount"]
        rows = [[i["paid_on"], i["identifier"], i["tenant_name"], i["method"], i["amount_paise"]] for i in items]
        money = [4]
    elif kind == "pending":
        head = ["Unit", "Renter", "Months due", "Oldest due date", "Amount due"]
        rows = [[i["identifier"], i["tenant_name"], i["open_months"], i["oldest_due"], i["amount_paise"]] for i in items]
        money = [4]
    elif kind == "overdue":
        head = ["Unit", "Renter", "Month", "Due date", "Days overdue", "Amount overdue"]
        rows = [[i["identifier"], i["tenant_name"], i["period_month"].strftime("%b %Y"), i["due_date"], i["days_overdue"], i["amount_paise"]] for i in items]
        money = [5]
    else:
        head = ["Unit", "Type", "Floor", "Property", "Address", "Renter", "Monthly rent"]
        rows = [[i["identifier"], i["kind"], floor_name(i.get("floor")), i["property_name"], i["address"], i["tenant_name"] or "Vacant", i["amount_paise"] or 0] for i in items]
        money = [6]
    names = {"collected": "Collected this month", "pending": "Pending", "overdue": "Overdue", "units": "Residential and commercial"}
    total = (("Total", int(d["total_paise"])) if d["total_paise"] is not None else None)
    t = _t(names[kind], head, rows, money, total)
    return _file(f"paymyrent-{kind}-{today:%Y%m%d}", fmt, f"PayMyRent — {names[kind]}", f"As on {today:%d-%m-%Y}", [t])


def _t(name, head, rows, money, total):
    from ..domain.report_files import table
    return table(name, head, rows, money, total)


def statement_tables(db: Db, tenancy_id: UUID) -> tuple[str, str, list]:
    head = db.one("""SELECT u.identifier, p.name, p.address, o.display_name, s.name AS tenant, t.items_provided, b.balance_paise, b.deposit_held_paise
                     FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                     JOIN owner_accounts o ON o.id = t.owner_account_id JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                     LEFT JOIN LATERAL (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) s ON true
                     WHERE t.id = :t""", t=tenancy_id)
    months = db.all("SELECT period_month, number, due_date, total_paise, open_paise, status FROM v_invoice_status WHERE tenancy_id = :t ORDER BY period_month", t=tenancy_id)
    pays = db.all("""SELECT p.paid_on, p.method, p.verification, p.status, p.amount_paise, r.number AS receipt
                     FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.tenancy_id = :t ORDER BY p.paid_on, p.created_at""", t=tenancy_id)
    title = f"Rent statement — {head['identifier']}"
    sub = f"{head['tenant'] or ''} · {head['name'] or ''} {head['address']} · Owner: {head['display_name']} · Deposit held {format_inr(head['deposit_held_paise'])}"
    items = [x.strip() for x in re.split(r"[\n,;]+", head["items_provided"] or "") if x.strip()]
    extra = [_t("Items provided", ["Item"], [[x] for x in items], [], None)] if items else []
    return title, sub, extra + [
        _t("Months", ["Month", "Bill no.", "Due date", "Billed", "Open", "Status"],
           [[m["period_month"].strftime("%b %Y"), m["number"], m["due_date"], m["total_paise"], m["open_paise"], m["status"]] for m in months], [3, 4],
           ("Total due now", int(head["balance_paise"]))),
        _t("Payments", ["Date", "Method", "How", "Status", "Amount", "Receipt"],
           [[p["paid_on"], p["method"], p["verification"], p["status"], p["amount_paise"], p["receipt"]] for p in pays], [4], None),
    ]


@router.get("/tenancies/{tenancy_id}/statement")
def statement(tenancy_id: UUID, user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db),
              fmt: Literal["html", "pdf", "xlsx"] = Query("html", alias="format")) -> Response:
    """Rent statement for the owner or the renter of this rental, as a web page, PDF or Excel sheet.
    The app downloads it with the sign-in token (a plain browser link has none and gets 401)."""
    tenancy_party(db, user, tenancy_id)
    if fmt in ("pdf", "xlsx"):
        title, sub, tables = statement_tables(db, tenancy_id)
        return _file(f"paymyrent-statement-{date.today():%Y%m%d}", fmt, title, sub, tables)
    from ..i18n.documents import render_statement
    return HTMLResponse(render_statement(db, tenancy_id, user.language))


@router.get("/tenant/report/export")
def tenant_report(fmt: Literal["xlsx", "pdf"] = Query("xlsx", alias="format"), user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> Response:
    """A renter's own report across all their rentals: what is due per rental and every payment they made."""
    rentals = db.all("""SELECT u.identifier, p.name AS property_name, p.address, o.display_name AS owner_name, t.monthly_rent_paise, t.status,
                               b.balance_paise, b.deposit_held_paise
                        FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                        JOIN owner_accounts o ON o.id = t.owner_account_id JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                        WHERE t.tenant_user_id = :u AND t.status IN ('active','ended') ORDER BY (t.status = 'active') DESC, o.display_name, u.identifier""", u=user.id)
    pays = db.all("""SELECT p.paid_on, u.identifier, o.display_name AS owner_name, p.method, p.status, p.amount_paise, r.number AS receipt
                     FROM payments p JOIN tenancies t ON t.id = p.tenancy_id JOIN units u ON u.id = t.unit_id
                     JOIN owner_accounts o ON o.id = t.owner_account_id LEFT JOIN receipts r ON r.payment_id = p.id
                     WHERE t.tenant_user_id = :u AND p.method <> 'deposit' ORDER BY p.paid_on DESC, p.created_at DESC LIMIT 1000""", u=user.id)
    due = sum(max(int(r["balance_paise"]), 0) for r in rentals if r["status"] == "active")
    paid = sum(int(p["amount_paise"]) for p in pays if p["status"] == "confirmed")
    tables = [
        _t("Rentals", ["Unit", "Property", "Owner", "Status", "Monthly rent", "Amount due", "Deposit held"],
           [[r["identifier"], r["property_name"] or r["address"], r["owner_name"], r["status"], r["monthly_rent_paise"], max(int(r["balance_paise"]), 0),
             r["deposit_held_paise"]] for r in rentals], [4, 5, 6], ("Total due", due)),
        _t("Payments", ["Date", "Unit", "Owner", "Method", "Status", "Amount", "Receipt"],
           [[p["paid_on"], p["identifier"], p["owner_name"], p["method"], p["status"], p["amount_paise"], p["receipt"]] for p in pays], [5], ("Total paid", paid)),
    ]
    return _file(f"paymyrent-my-rentals-{date.today():%Y%m%d}", fmt, "PayMyRent — My rentals", f"As on {date.today():%d-%m-%Y}", tables)


UPDATE_TEMPLATES = ("terms_changed", "relief_approved", "relief_declined", "cash_recorded", "deposit_changed", "payment_received", "charge_reviewed", "tenancy_closed", "vacate_declined", "owner_transferred")


@router.get("/tenant/updates")
def tenant_updates(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    """What the owner changed or recorded lately (rent, advance, cash received, deposit), in the renter's language.
    Read from the same notification records the SMS/push messages use, so the app and the message always say the same thing.
    The in-app copy exists even when SMS is off, over the plan cap or held for quiet hours."""
    from ..i18n.templates import render
    rows = db.all("""SELECT id, template, language, payload, created_at FROM notification_events
                     WHERE user_id = :u AND channel = 'push' AND template = ANY(:tpl) AND created_at > now() - interval '30 days'
                     ORDER BY created_at DESC LIMIT 10""", u=user.id, tpl=list(UPDATE_TEMPLATES))
    out = []
    for r in rows:
        try:
            text = render(r["template"], user.language, **r["payload"])
        except (KeyError, IndexError):
            continue
        out.append({"id": str(r["id"]), "template": r["template"], "text": text, "created_at": r["created_at"]})
    return {"items": out}
