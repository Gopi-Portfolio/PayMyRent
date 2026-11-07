"""Encrypt stored PANs; shared rate limiter table.

Revision ID: 0004
Revises: 0003
"""
from pathlib import Path

from alembic import op
from sqlalchemy import text

revision = "0004"
down_revision = "0003"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0006_security.sql").read_text(encoding="utf-8"))
    from app.core import crypto   # needs RG_PAN_ENCRYPTION_KEY to match what the app will use
    conn = op.get_bind()
    for oid, pan in conn.execute(text("SELECT owner_account_id, pan FROM owner_verifications WHERE pan IS NOT NULL")).all():
        conn.execute(text("UPDATE owner_verifications SET pan_enc=:e, pan_hash=:h, pan_masked=:m, pan=NULL WHERE owner_account_id=:o"),
                     {"e": crypto.encrypt(pan), "h": crypto.lookup_hash(pan), "m": crypto.mask_pan(pan), "o": oid})
    op.execute("ALTER TABLE owner_verifications DROP COLUMN pan")


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
