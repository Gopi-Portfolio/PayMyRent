"""Row-level security + the limited application role.

Revision ID: 0008
Revises: 0007
"""
from pathlib import Path

from alembic import op

revision = "0008"
down_revision = "0007"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0010_rls.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
