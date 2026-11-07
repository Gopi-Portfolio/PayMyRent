"""Owner hands the account to another number.

Revision ID: 0027
Revises: 0026
"""
from pathlib import Path

from alembic import op

revision = "0027"
down_revision = "0026"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0029_owner_transfers.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
