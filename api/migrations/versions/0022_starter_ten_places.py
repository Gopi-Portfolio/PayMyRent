"""The Rs 1 plan holds up to 10 places.

Revision ID: 0022
Revises: 0021
"""
from pathlib import Path

from alembic import op

revision = "0022"
down_revision = "0021"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0024_starter_ten_places.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
