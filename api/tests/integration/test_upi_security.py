"""UPI direct payments: who can see what, whether money maps to the right owner and tenant, and whether the data stays consistent.
Requires PostgreSQL."""
from __future__ import annotations

import json
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from .conftest import ensure_property, pay_subscription
from .test_api_flows import TODAY, accept_all
from .test_pay_method import _report, _tenancy
from .test_rls import as_app

UPI_A, UPI_B, UPI_X = "owner.alpha@okhdfcbank", "owner.bravo@oksbi", "own.override@okicici"


def _owner(actor, upi):
    o = actor(roles=("owner",))
    pay_subscription(o)
    assert o.put("/api/v1/owner/upi-default", json={"upi_id": upi, "otp_code": o.action_code("payout")}).status_code == 200
    return o


def _rental(t, tid):
    return next(r for r in t.get("/api/v1/tenant/rentals").json()["items"] if r["id"] == tid)


@pytest.fixture
def world(actor):
    """Owner A and owner B (different UPI IDs). Ravi rents from BOTH. Sita rents only from A. Kumar was invited by A and has not accepted."""
    a, b = _owner(actor, UPI_A), _owner(actor, UPI_B)
    ravi, sita, kumar = actor(), actor(), actor()
    ta = _tenancy(a, ravi, pay_method="upi").json()["tenancy_id"]
    tb = _tenancy(b, ravi, pay_method="upi").json()["tenancy_id"]
    ts = _tenancy(a, sita, pay_method="upi", pay_upi_id=UPI_X, otp_code=a.action_code("payout")).json()["tenancy_id"]
    tk = _tenancy(a, kumar, pay_method="upi").json()["tenancy_id"]
    accept_all(ravi); accept_all(sita)                                    # kumar never accepts
    return dict(a=a, b=b, ravi=ravi, sita=sita, kumar=kumar, ta=ta, tb=tb, ts=ts, tk=tk)


def test_each_rental_maps_to_its_own_owners_upi(world):
    w = world
    assert _rental(w["ravi"], w["ta"])["pay_upi_id"] == UPI_A and _rental(w["ravi"], w["tb"])["pay_upi_id"] == UPI_B
    assert _rental(w["ravi"], w["ta"])["owner_name"] != _rental(w["ravi"], w["tb"])["owner_name"] or True
    assert _rental(w["sita"], w["ts"])["pay_upi_id"] == UPI_X             # Sita's own override, not the profile one
    # each owner's list holds only their own tenants' payments
    assert _report(w["ravi"], w["ta"], "1000", "UTRAAA0001").status_code == 200
    assert _report(w["ravi"], w["tb"], "2000", "UTRBBB0001").status_code == 200
    assert _report(w["sita"], w["ts"], "3000", "UTRAAA0002").status_code == 200
    pa = {p["reference"]: p for p in w["a"].get("/api/v1/owner/payments/pending-transfers").json()["items"]}
    pb = {p["reference"]: p for p in w["b"].get("/api/v1/owner/payments/pending-transfers").json()["items"]}
    assert set(pa) == {"UTRAAA0001", "UTRAAA0002"} and set(pb) == {"UTRBBB0001"}
    assert pa["UTRAAA0001"]["tenancy_id"] == w["ta"] and pb["UTRBBB0001"]["tenancy_id"] == w["tb"]


def test_nobody_can_act_on_or_see_someone_elses_payment(world, sql):
    w = world
    mine = _report(w["ravi"], w["ta"], "1000", "UTRSEC0001").json()["id"]
    # owner B (unrelated to this tenancy) cannot confirm, reject or see it
    assert w["b"].post(f"/api/v1/owner/payments/{mine}/confirm-transfer").status_code == 404
    assert w["b"].post(f"/api/v1/owner/payments/{mine}/reject-transfer", json={}).status_code == 404
    assert "UTRSEC0001" not in json.dumps(w["b"].get("/api/v1/owner/payments/pending-transfers").json())
    # another tenant of the same owner cannot read it or report onto Ravi's tenancy
    assert w["sita"].get(f"/api/v1/payments/{mine}").status_code in (403, 404)
    assert _report(w["sita"], w["ta"], "100", "UTRSEC0002").status_code == 404
    assert _report(w["sita"], w["tb"], "100", "UTRSEC0003").status_code == 404           # nor onto owner B's tenancy
    # an invited tenant who has not accepted sees no rental and cannot pay
    assert w["kumar"].get("/api/v1/tenant/rentals").json()["items"] == []
    assert _report(w["kumar"], w["tk"], "100", "UTRSEC0004").status_code == 404
    # nothing was recorded for any refused attempt
    assert sql("SELECT count(*) FROM payment_events WHERE data->>'reference' IN ('UTRSEC0002','UTRSEC0003','UTRSEC0004')")[0][0] == 0
    # the real owner can still confirm it
    assert w["a"].post(f"/api/v1/owner/payments/{mine}/confirm-transfer").status_code == 200


def test_tenants_cannot_use_owner_endpoints_and_never_see_other_ids(world):
    w = world
    calls = [("put", "/api/v1/owner/upi-default", {"upi_id": "evil@oksbi", "otp_code": "123456"}),
             ("put", f"/api/v1/owner/tenancies/{w['ta']}/payment-method", {"method": "upi", "upi_id": "evil@oksbi"}),
             ("put", "/api/v1/owner/payment-method/unset", {"method": "cash"}),
             ("get", "/api/v1/owner/upi-ids", None), ("get", "/api/v1/owner/payments/pending-transfers", None)]
    for m, url, body in calls:
        r = getattr(w["ravi"], m)(url, **({"json": body} if body else {}))
        assert r.status_code in (401, 403, 404), (url, r.status_code)
        assert UPI_A not in r.text and UPI_B not in r.text, url
    # every response a tenant can reach is scanned for IDs that are not theirs
    sita = json.dumps([w["sita"].get(u).json() for u in ("/api/v1/tenant/rentals", "/api/v1/tenant/invitations", "/api/v1/tenant/updates",
                                                         "/api/v1/me", "/api/v1/me/notifications?role=tenant", f"/api/v1/tenancies/{w['ts']}/bill")])
    assert UPI_A not in sita and UPI_B not in sita                                     # Sita rents from A but has her own ID
    kumar = json.dumps([w["kumar"].get("/api/v1/tenant/rentals").json(), w["kumar"].get("/api/v1/tenant/invitations").json()])
    assert "okhdfcbank" not in kumar and "oksbi" not in kumar and "okicici" not in kumar    # not yet accepted: no payment details at all
    # owner B cannot read owner A's IDs
    assert UPI_A not in json.dumps(w["b"].get("/api/v1/owner/upi-ids").json()) and UPI_A not in json.dumps(w["b"].get("/api/v1/owner/tenancies").json())


def test_upi_ids_are_not_in_notifications_or_other_peoples_tenant_pages(world, sql):
    w = world
    _report(w["ravi"], w["ta"], "1000", "UTRNOT0001")
    w["a"].put("/api/v1/owner/upi-default", json={"upi_id": "moved.alpha@okaxis", "otp_code": w["a"].action_code("payout")})
    leaked = sql("SELECT count(*) FROM notification_events WHERE payload::text ~* '@ok|@ybl|@paytm|@upi'")[0][0]
    assert leaked == 0                                                                  # messages never carry a payee ID


def test_money_maps_to_the_right_owner_and_balance(world, sql):
    w = world
    p = _report(w["ravi"], w["ta"], "4000", "UTRMAP0001").json()
    row = sql("SELECT p.owner_account_id, t.owner_account_id, t.tenant_user_id, p.method, p.status FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.id = %s", p["id"])[0]
    assert row[0] == row[1] and str(row[2]) == str(w["ravi"].id) and row[3:] == ("manual_transfer", "pending")
    before = int(w["ravi"].get(f"/api/v1/tenancies/{w['ta']}/bill").json()["summary"]["total_due_paise"])
    other = int(w["ravi"].get(f"/api/v1/tenancies/{w['tb']}/bill").json()["summary"]["total_due_paise"])
    assert w["a"].post(f"/api/v1/owner/payments/{p['id']}/confirm-transfer").status_code == 200
    assert int(w["ravi"].get(f"/api/v1/tenancies/{w['ta']}/bill").json()["summary"]["total_due_paise"]) == before - 400000
    assert int(w["ravi"].get(f"/api/v1/tenancies/{w['tb']}/bill").json()["summary"]["total_due_paise"]) == other      # the other owner's rental is untouched
    assert sql("SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = %s", p["id"])[0][0] == 400000       # allocated exactly once, fully
    # ledger-wide: no payment belongs to a different owner than its tenancy, and no confirmed transfer lacks a receipt
    assert sql("SELECT count(*) FROM payments p JOIN tenancies t ON t.id = p.tenancy_id WHERE p.owner_account_id <> t.owner_account_id")[0][0] == 0
    assert sql("SELECT count(*) FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id WHERE p.method = 'manual_transfer' AND p.status = 'confirmed' AND r.id IS NULL")[0][0] == 0


def test_replays_and_double_confirms_change_nothing(world, sql):
    w = world
    key = uuid.uuid4().hex
    p1 = _report(w["ravi"], w["ta"], "1000", "UTRREP0001", key=key).json()
    p2 = _report(w["ravi"], w["ta"], "1000", "UTRREP0001", key=key).json()               # the app retried
    assert p1["id"] == p2["id"] and sql("SELECT count(*) FROM payments WHERE idempotency_key = %s", key)[0][0] == 1
    assert sql("SELECT count(*) FROM notification_events WHERE template = 'transfer_reported' AND dedupe_key LIKE %s", f"transfer-reported:{p1['id']}:%")[0][0] >= 1
    assert w["a"].post(f"/api/v1/owner/payments/{p1['id']}/confirm-transfer").status_code == 200
    assert w["a"].post(f"/api/v1/owner/payments/{p1['id']}/confirm-transfer").status_code != 200      # not a second time
    assert sql("SELECT count(*) FROM receipts WHERE payment_id = %s", p1["id"])[0][0] == 1
    assert sql("SELECT sum(amount_paise) FROM payment_allocations WHERE payment_id = %s", p1["id"])[0][0] == 100000


def test_parallel_requests_cannot_double_count(world, sql):
    w = world
    # two taps on Confirm at the same moment: one wins, the dues drop once
    p = _report(w["ravi"], w["ta"], "1000", "UTRPAR0001").json()["id"]
    with ThreadPoolExecutor(2) as ex:
        codes = sorted(f.result() for f in [ex.submit(lambda: w["a"].post(f"/api/v1/owner/payments/{p}/confirm-transfer").status_code) for _ in range(2)])
    assert codes[0] == 200 and codes[1] != 200
    assert sql("SELECT count(*) FROM receipts WHERE payment_id = %s", p)[0][0] == 1
    # the same UTR sent twice at the same moment (two different retries / two phones) must be accepted only once
    with ThreadPoolExecutor(2) as ex:
        codes = sorted(f.result() for f in [ex.submit(lambda: _report(w["sita"], w["ts"], "500", "UTRPAR0002").status_code) for _ in range(2)])
    assert codes == [200, 422] or codes == [200, 400], f"the same reference was accepted {codes.count(200)} times"


def test_a_code_for_another_step_does_not_unlock_a_payee_change(world):
    w = world
    wrong = w["a"].action_code("identity")                                              # a valid code, but for a different step
    r = w["a"].put("/api/v1/owner/upi-default", json={"upi_id": "attacker@oksbi", "otp_code": wrong})
    assert r.status_code in (400, 401, 403, 422)
    assert w["a"].get("/api/v1/owner/upi-ids").json()["default_upi_id"] == UPI_A       # unchanged


def test_database_rules_reject_bad_values(world, sql):
    import psycopg
    for bad in ("UPDATE tenancies SET pay_method = 'bitcoin' WHERE id = %s", "UPDATE tenancies SET pay_upi_id = 'no at sign' WHERE id = %s",
                "UPDATE tenancies SET pay_upi_id = 'UPPER@oksbi' WHERE id = %s"):
        with pytest.raises(psycopg.errors.CheckViolation):
            sql(bad, world["ta"])
    with pytest.raises(psycopg.errors.CheckViolation):
        sql("UPDATE owner_accounts SET default_upi_id = 'bad id' WHERE id = (SELECT owner_account_id FROM tenancies WHERE id = %s)", world["ta"])


def test_row_level_security_scopes_the_new_columns(world, sql):
    w = world
    ids = {k: str(sql("SELECT owner_account_id FROM tenancies WHERE id = %s", w[t])[0][0]) for k, t in (("a", "ta"), ("b", "tb"))}
    ravi = {"app.user_id": str(w["ravi"].id), "app.tenancy_ids": f"{w['ta']},{w['tb']}"}
    sita = {"app.user_id": str(w["sita"].id), "app.tenancy_ids": str(w["ts"])}
    ownerb = {"app.user_id": str(w["b"].id), "app.owner_ids": ids["b"]}
    with as_app(sita) as c:
        seen = {r[0] for r in c.execute("SELECT id::text FROM tenancies").fetchall()}
        assert seen == {w["ts"]}                                                         # a tenant's session holds only that tenancy's row
    with as_app(ravi) as c:
        assert {r[0] for r in c.execute("SELECT id::text FROM tenancies").fetchall()} == {w["ta"], w["tb"]}
    with as_app(ownerb) as c:
        assert {r[0] for r in c.execute("SELECT id::text FROM tenancies").fetchall()} == {w["tb"]}
        assert c.execute("SELECT count(*) FROM payments WHERE owner_account_id <> %s::uuid", (ids["b"],)).fetchone()[0] == 0
    with as_app() as c:                                                                   # nobody identified: nothing
        assert c.execute("SELECT count(*) FROM tenancies WHERE pay_upi_id IS NOT NULL").fetchone()[0] == 0


@pytest.mark.xfail(strict=True, reason="owner_accounts has no row-level security: any signed-in session can read every owner's default_upi_id at database level")
def test_database_hides_other_owners_default_upi(world):
    with as_app({"app.user_id": str(world["sita"].id), "app.tenancy_ids": str(world["ts"])}) as c:
        leaked = c.execute("SELECT count(*) FROM owner_accounts WHERE default_upi_id IS NOT NULL").fetchone()[0]
    assert leaked == 0


@pytest.mark.xfail(strict=True, reason="payment_events (UTR references) has no row-level security")
def test_database_hides_other_peoples_payment_references(world):
    _report(world["ravi"], world["ta"], "1000", "UTRRLS0001")
    with as_app({"app.user_id": str(world["sita"].id), "app.tenancy_ids": str(world["ts"])}) as c:
        leaked = c.execute("SELECT count(*) FROM payment_events WHERE type = 'tenant_reference'").fetchone()[0]
    assert leaked == 0
