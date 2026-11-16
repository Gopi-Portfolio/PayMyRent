"""Safe retries for data-entry requests (offline capture and sync).

Revision ID: 0043
Revises: 0042
"""
from pathlib import Path

from alembic import op

revision = "0043"
down_revision = "0042"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0045_request_idempotency.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
