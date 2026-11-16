"""Plan prices: Starter ₹50, Growth ₹100, Business ₹500; Max retired.

Revision ID: 0038
Revises: 0037
"""
from pathlib import Path

from alembic import op

revision = "0038"
down_revision = "0037"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0040_plan_prices.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
