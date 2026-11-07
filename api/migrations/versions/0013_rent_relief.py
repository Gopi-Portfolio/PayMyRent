"""Rent relief: pay part of the month now, the rest moves to next month.

Revision ID: 0013
Revises: 0012
"""
from pathlib import Path

from alembic import op

revision = "0013"
down_revision = "0012"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0015_rent_relief.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
