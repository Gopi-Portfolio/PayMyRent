"""The owner's usual way of receiving rent lives on the owner account; a tenant's own choice is an exception.

Revision ID: 0031
Revises: 0030
"""
from pathlib import Path

from alembic import op

revision = "0031"
down_revision = "0030"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0033_owner_default_method.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
