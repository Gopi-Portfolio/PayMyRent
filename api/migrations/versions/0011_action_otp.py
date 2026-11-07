"""One-time codes that approve a verification step.

Revision ID: 0011
Revises: 0010
"""
from pathlib import Path

from alembic import op

revision = "0011"
down_revision = "0010"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0013_action_otp.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
