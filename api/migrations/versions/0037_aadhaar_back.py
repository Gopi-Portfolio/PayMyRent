"""Aadhaar back page (address) in the owner documents.

Revision ID: 0037
Revises: 0036
"""
from pathlib import Path

from alembic import op

revision = "0037"
down_revision = "0036"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0039_aadhaar_back.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
