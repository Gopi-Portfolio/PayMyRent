"""Renters can write to the owner of their rental.

Revision ID: 0035
Revises: 0034
"""
from pathlib import Path

from alembic import op

revision = "0035"
down_revision = "0034"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0037_renter_messages.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
