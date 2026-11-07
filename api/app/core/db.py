"""SQLAlchemy 2 Core access. Financial writes go through the rg_* PL/pgSQL functions,
so every caller (API, jobs, imports) shares the same locking and invariants."""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine, RowMapping
from sqlalchemy.exc import DBAPIError, IntegrityError

from .config import get_settings
from .errors import AppError, from_db_message

_engine: Engine | None = None
_app_engine: Engine | None = None


def _make_engine(url: str) -> Engine:
    s = get_settings()
    return create_engine(url, pool_pre_ping=True, pool_size=s.db_pool_size, max_overflow=s.db_max_overflow, pool_recycle=1800,
                         connect_args={"options": "-c timezone=UTC -c statement_timeout=15000"})


def engine() -> Engine:
    """System connection (owns the tables, not restricted by row-level security): migrations, scheduled jobs, webhooks, admin."""
    global _engine
    if _engine is None:
        _engine = _make_engine(get_settings().database_url)
    return _engine


def app_engine() -> Engine:
    """Connection for signed-in requests: the limited role pmr_app, restricted by row-level security."""
    global _app_engine
    s = get_settings()
    if not s.app_database_url:
        return engine()
    if _app_engine is None:
        _app_engine = _make_engine(s.app_database_url)
    return _app_engine


class Db:
    def __init__(self, conn: Connection) -> None:
        self.conn = conn

    def all(self, sql: str, **p: Any) -> list[RowMapping]:
        return list(self.conn.execute(text(sql), p).mappings())

    def one(self, sql: str, **p: Any) -> RowMapping | None:
        return self.conn.execute(text(sql), p).mappings().first()

    def scalar(self, sql: str, **p: Any) -> Any:
        return self.conn.execute(text(sql), p).scalar()

    def exec(self, sql: str, **p: Any) -> int:
        return self.conn.execute(text(sql), p).rowcount

    def ctx(self, user_id: Any = None, owner_ids: list | None = None, phones: list | None = None, tenancy_ids: list | None = None) -> None:
        """Tell the database who is asking (transaction-local). Row-level security uses this to decide which rows are visible."""
        if user_id is not None:
            self.conn.execute(text("SELECT set_config('app.user_id', :v, true)"), {"v": str(user_id)})
        if owner_ids is not None:
            self.conn.execute(text("SELECT set_config('app.owner_ids', :v, true)"), {"v": ",".join(str(o) for o in owner_ids)})
        if phones is not None:
            self.conn.execute(text("SELECT set_config('app.phones', :v, true)"), {"v": ",".join(phones)})
        if tenancy_ids is not None:
            self.conn.execute(text("SELECT set_config('app.tenancy_ids', :v, true)"), {"v": ",".join(str(t) for t in tenancy_ids)})

    def ctx_add_tenancy(self, tenancy_id: Any) -> None:
        """A renter just accepted an invitation in this request: from now on that tenancy is theirs for row-level security."""
        self.conn.execute(text("SELECT set_config('app.tenancy_ids', concat_ws(',', nullif(current_setting('app.tenancy_ids', true), ''), CAST(:t AS text)), true)"),
                          {"t": str(tenancy_id)})

    def must(self, sql: str, what: str = "record", **p: Any) -> RowMapping:
        row = self.one(sql, **p)
        if row is None:
            raise AppError("NOT_FOUND", f"{what} not found")
        return row

    def audit(self, actor: Any, owner: Any, action: str, entity_type: str, entity_id: Any,
              before: dict | None = None, after: dict | None = None) -> None:
        import json
        self.exec("""INSERT INTO audit_events(actor_user_id, owner_account_id, action, entity_type, entity_id, before, after)
                     VALUES (:a, :o, :act, :et, :eid, CAST(:b AS jsonb), CAST(:af AS jsonb))""",
                  a=actor, o=owner, act=action, et=entity_type, eid=entity_id,
                  b=json.dumps(before, default=str) if before else None,
                  af=json.dumps(after, default=str) if after else None)


def translate_db_error(e: DBAPIError) -> AppError | None:
    orig = getattr(e, "orig", None)
    diag = getattr(orig, "diag", None)
    msg = (getattr(diag, "message_primary", None) or str(orig or e)).strip()
    mapped = from_db_message(msg)
    if mapped:
        return mapped
    if isinstance(e, IntegrityError):
        constraint = getattr(diag, "constraint_name", None) or ""
        friendly = {
            "ux_contacts_verified_mobile": ("PHONE_IN_USE", "this number is linked to another account"),
            "ux_unit_one_live_tenancy": ("CONFLICT", "this unit already has a tenant or pending invitation"),
            "ux_unit_place": ("CONFLICT", "a unit with this number already exists on this floor of this property"),
            "ux_sub_order_open": ("CONFLICT", "a checkout for this plan is already open"),
            "ux_property_address_key": ("PROPERTY_ALREADY_REGISTERED", "This property is already registered on PayMyRent. If you co-own it, ask the registered owner to add your mobile number under Owner numbers."),
            "ux_property_proof": ("PROPERTY_PROOF_ALREADY_USED", "This ownership document number is already registered for another property."),
        }.get(constraint)
        if friendly:
            return AppError(*friendly)
        return AppError("CONFLICT", "duplicate or conflicting record", constraint=constraint)
    return None


@contextmanager
def _run(eng: Engine) -> Iterator[Db]:
    try:
        with eng.begin() as conn:
            yield Db(conn)
    except DBAPIError as e:
        mapped = translate_db_error(e)
        if mapped:
            raise mapped from e
        raise


@contextmanager
def transaction() -> Iterator[Db]:
    """System transaction (scheduled jobs, webhooks, admin): not restricted by row-level security."""
    with _run(engine()) as db:
        yield db


def get_db() -> Iterator[Db]:
    """FastAPI dependency: one transaction per request, committed on success, as the limited role under row-level security.
    Until the request is authenticated the database sees nobody, so tenancy/payment/unit rows are invisible."""
    with _run(app_engine()) as db:
        yield db
