"""Renters recorded before they are allotted a place.

Revision ID: 0044
Revises: 0043
"""
from pathlib import Path

from alembic import op

revision = "0044"
down_revision = "0043"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0046_renters.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
