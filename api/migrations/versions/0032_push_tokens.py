"""Phone push tokens (Firebase Cloud Messaging).

Revision ID: 0032
Revises: 0031
"""
from pathlib import Path

from alembic import op

revision = "0032"
down_revision = "0031"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0034_push_tokens.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
