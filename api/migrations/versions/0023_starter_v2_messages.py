"""The new version of the Rs 1 plan keeps its message allowance.

Revision ID: 0023
Revises: 0022
"""
from pathlib import Path

from alembic import op

revision = "0023"
down_revision = "0022"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0025_starter_v2_messages.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
