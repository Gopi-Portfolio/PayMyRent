"""Photos for the automatic owner document check.

Revision ID: 0036
Revises: 0035
"""
from pathlib import Path

from alembic import op

revision = "0036"
down_revision = "0035"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0038_owner_documents.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
