"""Plans per property, AI token allowances, and the Max plan (up to 100 properties).

Revision ID: 0024
Revises: 0023
"""
from pathlib import Path

from alembic import op

revision = "0024"
down_revision = "0023"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0026_plans_v3.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
