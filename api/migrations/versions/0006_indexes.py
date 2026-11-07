"""Indexes found missing by load testing.

Revision ID: 0006
Revises: 0005
"""
from pathlib import Path

from alembic import op

revision = "0006"
down_revision = "0005"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0008_indexes.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
