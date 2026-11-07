"""Initial schema, financial functions and plan catalogue v1.

Revision ID: 0001
Revises:
"""
from pathlib import Path

from alembic import op

revision = "0001"
down_revision = None
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    # Executed through the raw psycopg cursor with no parameters, so the multi-statement files
    # (DO blocks, PL/pgSQL bodies, literal % signs) are sent verbatim.
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        for name in ("0001_tables.sql", "0002_functions.sql", "0003_plans.sql"):
            cur.execute((SQL_DIR / name).read_text(encoding="utf-8"))


def downgrade() -> None:
    # Financial data is never dropped by a migration. Restore from backup instead.
    raise RuntimeError("downgrade of the initial schema is not supported")
