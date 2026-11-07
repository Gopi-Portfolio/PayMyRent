"""Renter asks the owner to vacate a rental.

Revision ID: 0026
Revises: 0025
"""
from pathlib import Path

from alembic import op

revision = "0026"
down_revision = "0025"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0028_vacate_requests.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
