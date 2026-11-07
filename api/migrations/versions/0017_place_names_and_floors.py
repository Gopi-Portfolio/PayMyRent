"""Free-form names for commercial places, and the floor of a unit.

Revision ID: 0017
Revises: 0016
"""
from pathlib import Path

from alembic import op

revision = "0017"
down_revision = "0016"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0019_place_names_and_floors.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
