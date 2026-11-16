"""Growth plan: paid-message allowance back to 150.

Revision ID: 0041
Revises: 0040
"""
from pathlib import Path

from alembic import op

revision = "0041"
down_revision = "0040"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0043_growth_messages_restore.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
