"""A unit is one address however it is spelled.

Revision ID: 0012
Revises: 0011
"""
from pathlib import Path

from alembic import op

revision = "0012"
down_revision = "0011"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0014_unit_identity.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
