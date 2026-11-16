"""Growth plan: ₹100, up to 50 places, up to 5 properties.

Revision ID: 0039
Revises: 0038
"""
from pathlib import Path

from alembic import op

revision = "0039"
down_revision = "0038"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0041_growth_fifty_places.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
