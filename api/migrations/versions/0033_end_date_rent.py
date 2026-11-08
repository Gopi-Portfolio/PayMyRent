"""Re-work billed rent when a rental's end date moves.

Revision ID: 0033
Revises: 0032
"""
from pathlib import Path

from alembic import op

revision = "0033"
down_revision = "0032"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0035_end_date_rent.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
