"""API integration tests: real FastAPI app + real PostgreSQL (docker compose `db` or CI service).
Each test session builds a fresh database from the SQL migrations."""
from __future__ import annotations

import os
import uuid
from pathlib import Path

import psycopg
import pytest

ADMIN_DSN = os.environ.get("RG_TEST_ADMIN_DSN", "postgresql://paymyrent:paymyrent@localhost:5432/postgres")
DB_NAME = f"rg_it_{uuid.uuid4().hex[:8]}"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


@pytest.fixture(scope="session", autouse=True)
def database():
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute(f"CREATE DATABASE {DB_NAME}")
    dsn = ADMIN_DSN.rsplit("/", 1)[0] + "/" + DB_NAME
    with psycopg.connect(dsn, autocommit=True) as c:
        for f in sorted(SQL_DIR.glob("0*.sql")):
            c.execute(f.read_text(encoding="utf-8"))
    # the API's signed-in requests run as the limited role under row-level security (the SQL files create the role; give it a login)
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute("ALTER ROLE pmr_app LOGIN PASSWORD 'pmr_app'")
    host_part = dsn.split("@", 1)[1]
    app_dsn = f"postgresql+psycopg://pmr_app:pmr_app@{host_part}"
    os.environ.update(RG_DATABASE_URL=dsn.replace("postgresql://", "postgresql+psycopg://"), RG_APP_DATABASE_URL=app_dsn, RG_APP_ENV="test", RG_ADMIN_TOKEN="test-admin-token",
                      RG_DEV_AUTH_ENABLED="true", RG_PUBLIC_BASE_URL="http://testserver")
    yield dsn
    from app.core import db as dbmod
    for e in (dbmod._engine, dbmod._app_engine):
        if e is not None:
            e.dispose()
    with psycopg.connect(ADMIN_DSN, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {DB_NAME} WITH (FORCE)")


@pytest.fixture(scope="session")
def client(database):
    from fastapi.testclient import TestClient

    from app.main import create_app
    return TestClient(create_app())


@pytest.fixture
def sql(database):
    def run(q: str, *params):
        with psycopg.connect(database, autocommit=True) as c:
            cur = c.execute(q, params or None)
            return cur.fetchall() if cur.description else None
    return run


_counter = iter(range(10_000_000, 99_999_999))


def new_phone() -> str:
    return f"9{next(_counter):09d}"[:10]


# the verification steps that need a one-time code sent to the account's own mobile
GATED = {("POST", "/api/v1/me/identity/start"): "identity", ("PUT", "/api/v1/owner/verification"): "owner_details",
         ("POST", "/api/v1/owner/properties"): "property", ("POST", "/api/v1/owner/payout-account"): "payout",
         ("PUT", "/api/v1/owner/owner-numbers"): "co_owner", ("POST", "/api/v1/owner/transfer"): "transfer", ("POST", "/api/v1/subscription/checkout"): "co_owner"}


class Actor:
    auto_otp = True        # tests of the code itself switch this off

    def __init__(self, client, phone: str | None = None, name: str = "Test User", roles=("tenant",), identity: bool = True):
        self.c, self.phone = client, phone or new_phone()
        r = client.post("/api/v1/dev/otp/request", json={"phone": self.phone})
        assert r.status_code == 200, r.text
        r = client.post("/api/v1/dev/otp/verify", json={"phone": self.phone, "code": r.json()["demo_code"]})
        self.token = r.json()["id_token"]
        me = self.post("/api/v1/auth/session").json()
        self.id = me["id"]
        self.post("/api/v1/me/roles", json={"roles": list(roles)})
        me = self.get("/api/v1/me").json()
        self.put("/api/v1/me/profile", json={"full_name": name, "preferred_language": "en", "version": me["version"]})
        if "owner" in roles:   # owners must submit their details before onboarding tenants (unique PAN per owner)
            self.put("/api/v1/owner/verification", json={
                "legal_name": name, "pan": "ABCDE" + str(next(_counter) % 10000).zfill(4) + "F", "address": "1 Test Street, Madurai",
                "proof_type": "property_tax", "proof_ref": "PT-TEST-001", "declare": True})
            if identity:
                self.verify_identity()

    def verify_identity(self) -> None:
        """Photo ID done the real way: start (with the code), then the provider's signed 'verified' result."""
        from app.providers.kyc import SandboxKyc
        notice = self.get("/api/v1/me/identity").json()["notice_version"]
        out = self.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice}).json()
        sid = out["session"]["url"].rsplit("/", 1)[1]
        p = SandboxKyc("sandbox-kyc-webhook-secret", "http://testserver")
        body = p.build_event(sid, "verified")
        assert self.c.post("/api/v1/webhooks/kyc", content=body, headers={"x-kyc-signature": p.sign(body)}).status_code == 200

    def h(self, extra=None):
        return {"Authorization": f"Bearer {self.token}", **(extra or {})}

    def get(self, url, **kw):
        return self.c.get(url, headers=self.h(kw.pop("headers", None)), **kw)

    def action_code(self, action: str, headers=None) -> str:
        r = self.c.post("/api/v1/me/action-otp/request", json={"action": action}, headers=self.h(headers))
        assert r.status_code == 200, r.text
        return r.json()["demo_code"]

    def _with_code(self, method, url, kw):
        j = kw.get("json")
        if method == "POST" and url.endswith("/payments/cash") and isinstance(j, dict) and self.auto_otp and "cash_received_confirmed" not in j:
            kw["json"] = j = {**j, "cash_received_confirmed": True}       # the owner's confirmation, as the app sends it
        action = GATED.get((method, url))
        if not (self.auto_otp and action and isinstance(j, dict) and "otp_code" not in j):
            return
        if url.endswith("/subscription/checkout") and not j.get("co_owners"):
            return
        if url.endswith("/owner/verification") and not j.get("declare"):
            return                                        # refused for another reason before any code is needed
        kw["json"] = {**j, "otp_code": self.action_code(action, kw.get("headers"))}

    def post(self, url, **kw):
        self._with_code("POST", url, kw)
        return self.c.post(url, headers=self.h(kw.pop("headers", None)), **kw)

    def put(self, url, **kw):
        self._with_code("PUT", url, kw)
        return self.c.put(url, headers=self.h(kw.pop("headers", None)), **kw)

    def patch(self, url, **kw):
        return self.c.patch(url, headers=self.h(kw.pop("headers", None)), **kw)

    def delete(self, url, **kw):
        return self.c.delete(url, headers=self.h(kw.pop("headers", None)), **kw)


def pay_subscription(owner: Actor, plan: str = "growth") -> dict:
    r = owner.post("/api/v1/subscription/checkout", json={"plan_code": plan, "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 200, r.text
    out = r.json()
    if out.get("free_month"):
        return out                      # the first month is free: the plan is already active, so there is nothing to pay
    oid = out["checkout"]["pay_url"].split("/")[-1].split("?")[0]
    r = owner.c.post(f"/api/v1/sandbox/pay/subscription/{oid}", content=b"outcome=success",
                     headers={"content-type": "application/x-www-form-urlencoded"})
    assert "activated" in r.text, r.text
    return out


def used_free_month(sql, owner: Actor) -> None:
    """Give the owner's account an earlier, finished plan, so its next checkout is a paid order (the first month of a plan is free, once)."""
    sql("""INSERT INTO owner_subscriptions(owner_account_id, plan_id, plan_code, price_paise, max_units, status, period_start, period_end, grace_until)
           SELECT a.id, p.id, p.code, p.price_paise, p.max_units, 'completed', now() - interval '90 days', now() - interval '60 days', now() - interval '53 days'
           FROM owner_accounts a, subscription_plans p WHERE a.primary_user_id = %s AND p.code = 'starter' AND p.status = 'active'""", owner.id)


@pytest.fixture
def actor(client):
    return lambda **kw: Actor(client, **kw)


_prop_counter = iter(range(1, 10_000_000))
ADMIN = {"x-admin-token": "test-admin-token"}


def property_body(n: int | None = None, **over) -> dict:
    """A valid, unique property: every owner in a test gets its own address and its own ownership proof number."""
    n = n or next(_prop_counter)
    body = {"address": f"{n} Test Street, Anna Nagar", "name": f"Test Complex {n}", "city": "Madurai", "state": "Tamil Nadu", "pincode": "625001",
            "kind": "commercial", "proof_type": "property_tax", "proof_ref": f"PT-MDU-{n:06d}-X", "declare": True}
    body.update(over)
    return body


def ensure_property(owner, verified: bool = True) -> str:
    """The owner's (single) property: created with proof and verified by a reviewer, once per owner."""
    if getattr(owner, "_pid", None):
        return owner._pid
    r = owner.post("/api/v1/owner/properties", json=property_body())
    assert r.status_code == 200, r.text
    owner._pid = r.json()["id"]
    if verified:
        a = owner.c.post(f"/api/v1/admin/review/property/{owner._pid}", json={"decision": "approve"}, headers=ADMIN)
        assert a.status_code == 200, a.text
    return owner._pid
