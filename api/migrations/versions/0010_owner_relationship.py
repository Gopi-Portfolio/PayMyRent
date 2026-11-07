"""Relationship of a second owner to the primary owner.

Revision ID: 0010
Revises: 0009
"""
from pathlib import Path

from alembic import op

revision = "0010"
down_revision = "0009"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0012_owner_relationship.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
