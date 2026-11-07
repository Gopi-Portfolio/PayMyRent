"""Agreements: extension / new agreement, with history kept.

Revision ID: 0018
Revises: 0017
"""
from pathlib import Path

from alembic import op

revision = "0018"
down_revision = "0017"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0020_agreements.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
