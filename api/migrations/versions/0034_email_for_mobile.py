"""Each email belongs to one of the person's own mobile numbers.

Revision ID: 0034
Revises: 0033
"""
from pathlib import Path

from alembic import op

revision = "0034"
down_revision = "0033"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0036_email_for_mobile.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
