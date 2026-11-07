"""Owner-to-renter messages with translation.

Revision ID: 0021
Revises: 0020
"""
from pathlib import Path

from alembic import op

revision = "0021"
down_revision = "0020"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0023_messages.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
