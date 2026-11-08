"""The owner's UPI ID lives on the owner account; a tenant's own UPI ID is only an override.

Revision ID: 0030
Revises: 0029
"""
from pathlib import Path

from alembic import op

revision = "0030"
down_revision = "0029"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0032_owner_default_upi.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
