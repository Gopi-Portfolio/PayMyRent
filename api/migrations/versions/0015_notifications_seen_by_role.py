"""The bell is per role.

Revision ID: 0015
Revises: 0014
"""
from pathlib import Path

from alembic import op

revision = "0015"
down_revision = "0014"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0017_notifications_seen_by_role.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
