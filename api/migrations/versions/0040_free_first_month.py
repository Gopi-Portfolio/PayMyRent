"""The first month of any plan is free (once per owner account).

Revision ID: 0040
Revises: 0039
"""
from pathlib import Path

from alembic import op

revision = "0040"
down_revision = "0039"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0042_free_first_month.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
