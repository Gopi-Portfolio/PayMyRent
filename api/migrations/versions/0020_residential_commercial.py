"""Only residential and commercial places.

Revision ID: 0020
Revises: 0019
"""
from pathlib import Path

from alembic import op

revision = "0020"
down_revision = "0019"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0022_residential_commercial.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
