"""Row-level security, tested directly against the database as the limited role the API uses (no application code involved):
even a query that forgets every WHERE clause only ever returns the asking person's own rows."""
from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import date

import psycopg
import pytest

from .conftest import pay_subscription
from .test_api_flows import accept_all, onboard

TODAY = date.today()
M0 = TODAY.replace(day=1)
TABLES = ["properties", "units", "tenancies", "monthly_invoices", "invoice_lines", "payments", "ledger_entries", "receipts", "notes",
          "disputes", "deposits", "deposit_transactions", "tenancy_contact_snapshots", "tenancy_invitations", "recurring_charge_config"]


@contextmanager
def as_app(ctx=None):
    """A connection as pmr_app with the given who-is-asking settings, like one API request."""
    dsn = os.environ["RG_APP_DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(dsn) as c:
        for k, v in (ctx or {}).items():
            c.execute("SELECT set_config(%s, %s, true)", (k, v))
        yield c
        c.rollback()


def count(c, table):
    return c.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


@pytest.fixture
def world(actor, sql):
    """Owner A with a renter and owner B with a renter, each with a bill, a payment and a note."""
    out = {}
    for name in ("a", "b"):
        o = actor(roles=("owner",), name=f"Owner {name}"); pay_subscription(o)
        t = actor(roles=("tenant",), name=f"Renter {name}")
        tid = onboard(o, t.phone, ident=f"{name.upper()}-1", deposit="10000")["tenancy_id"]; accept_all(t)
        o.post(f"/api/v1/owner/tenancies/{tid}/invoices", params={"month": M0.isoformat()})
        pay = o.post(f"/api/v1/owner/tenancies/{tid}/payments/cash", json={"amount": "500", "idempotency_key": f"rls-{name}-{tid}"}).json()
        o.post(f"/api/v1/tenancies/{tid}/notes", json={"target_type": "tenancy", "target_id": tid, "body": f"note {name}"})
        oid = str(sql("SELECT id FROM owner_accounts WHERE primary_user_id = %s", o.id)[0][0])
        out[name] = dict(owner=o, tenant=t, tid=tid, oid=oid, pay=pay["id"], uid=str(t.id), phone="+91" + t.phone)
    return out


def test_nobody_sees_nothing_without_saying_who_they_are(world):
    with as_app() as c:
        for t in TABLES:
            assert count(c, t) == 0, f"{t} is visible with no identity"
        assert c.execute("SELECT count(*) FROM v_tenancy_balance").fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM v_invoice_status").fetchone()[0] == 0


def test_a_query_that_forgets_its_where_clause_only_returns_the_owners_own_rows(world):
    a, b = world["a"], world["b"]
    with as_app({"app.user_id": str(a["owner"].id), "app.owner_ids": a["oid"]}) as c:
        # "SELECT * FROM payments" with no filter at all
        assert {str(r[0]) for r in c.execute("SELECT id FROM payments")} == {a["pay"]}
        assert {str(r[0]) for r in c.execute("SELECT id FROM tenancies")} == {a["tid"]}
        assert count(c, "units") == 1 and count(c, "properties") == 1
        assert c.execute("SELECT count(*) FROM payments WHERE id = %s", (b["pay"],)).fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM tenancies WHERE id = %s", (b["tid"],)).fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM notes WHERE body = 'note b'").fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM v_tenancy_balance").fetchone()[0] == 1           # views do not bypass it
        # and it cannot write into, or change, someone else's data either
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("INSERT INTO notes(owner_account_id, tenancy_id, target_type, target_id, author_user_id, author_role, body) VALUES (%s, %s, 'tenancy', %s, %s, 'owner', 'x')",
                      (b["oid"], b["tid"], b["tid"], a["owner"].id))
    with as_app({"app.user_id": str(a["owner"].id), "app.owner_ids": a["oid"]}) as c:
        assert c.execute("UPDATE tenancies SET monthly_rent_paise = 1 WHERE id = %s", (b["tid"],)).rowcount == 0


def test_a_renter_sees_only_their_own_rental_and_unit(world):
    a, b = world["a"], world["b"]
    # the API computes the renter's tenancy list once per request and puts it in app.tenancy_ids
    with as_app({"app.user_id": a["uid"], "app.phones": a["phone"], "app.tenancy_ids": a["tid"]}) as c:
        assert {str(r[0]) for r in c.execute("SELECT id FROM tenancies")} == {a["tid"]}
        assert count(c, "units") == 1 and count(c, "properties") == 1 and count(c, "monthly_invoices") == 1 and count(c, "payments") == 1
        assert c.execute("SELECT count(*) FROM payments WHERE id = %s", (b["pay"],)).fetchone()[0] == 0
    # a renter who is ALSO someone's owner sees the two sides separately, never the owner's other renters
    with as_app({"app.user_id": a["uid"], "app.owner_ids": b["oid"], "app.phones": a["phone"], "app.tenancy_ids": a["tid"]}) as c:
        assert {str(r[0]) for r in c.execute("SELECT id FROM tenancies")} == {a["tid"], b["tid"]}


def test_a_recycled_phone_number_does_not_reach_an_old_accepted_tenancy(world):
    a = world["a"]
    with as_app({"app.user_id": str(uuid.uuid4()), "app.phones": a["phone"]}) as c:      # a stranger who now holds the old number
        assert count(c, "tenancies") == 0 and count(c, "payments") == 0 and count(c, "units") == 0


def test_the_system_connection_is_not_restricted(world, sql):
    assert sql("SELECT count(*) FROM tenancies")[0][0] >= 2          # migrations, jobs, webhooks and admin still see everything
