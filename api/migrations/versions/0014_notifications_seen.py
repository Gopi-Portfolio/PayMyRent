"""When a person last opened their notifications (drives the bell's unread count).

Revision ID: 0014
Revises: 0013
"""
from pathlib import Path

from alembic import op

revision = "0014"
down_revision = "0013"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0016_notifications_seen.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
