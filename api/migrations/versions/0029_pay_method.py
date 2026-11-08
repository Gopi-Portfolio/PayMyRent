"""How the owner receives rent, chosen per tenant (UPI direct, online, cash).

Revision ID: 0029
Revises: 0028
"""
from pathlib import Path

from alembic import op

revision = "0029"
down_revision = "0028"
SQL_DIR = Path(__file__).resolve().parents[2] / "app" / "db" / "sql"


def upgrade() -> None:
    raw = op.get_bind().connection.dbapi_connection
    with raw.cursor() as cur:
        cur.execute((SQL_DIR / "0031_pay_method.sql").read_text(encoding="utf-8"))


def downgrade() -> None:
    raise RuntimeError("downgrade is not supported")
