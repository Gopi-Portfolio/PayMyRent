"""Commercial units, and the list of items provided with a rental.

Revision ID: 0016
Revises: 0015
"""
from pathlib import Path

from alembic import op

revision = "0016"
down_revision = "0015"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0018_commercial_and_items.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
