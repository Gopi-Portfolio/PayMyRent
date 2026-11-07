"""Deploy step, run after migrations: give the limited application role its login password (from the environment, never from git).
    RG_APP_DB_PASSWORD=...  python -m app.db.provision"""
from __future__ import annotations

import os
import sys

import psycopg
from psycopg import sql

from app.core.config import get_settings


def main() -> int:
    s = get_settings()
    dsn = s.database_url.replace("postgresql+psycopg://", "postgresql://")
    demo = os.environ.get("RG_DEMO_AUTO_VERIFY_PROPERTIES", "off").lower() == "on"
    if demo and s.app_env == "production":
        print("provision: RG_DEMO_AUTO_VERIFY_PROPERTIES is not allowed in production")
        return 1
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("INSERT INTO system_flags(key, value) VALUES ('demo_auto_verify_properties', %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                  ("on" if demo else "off",))
        pw = os.environ.get("RG_APP_DB_PASSWORD", "")
        if pw:
            c.execute(sql.SQL("ALTER ROLE pmr_app LOGIN PASSWORD {}").format(sql.Literal(pw)))
    print("provision: application role ready" if pw else "provision: RG_APP_DB_PASSWORD not set; application role left as it is",
          "| demo property auto-verification:", "ON (local only)" if demo else "off")
    return 0


if __name__ == "__main__":
    sys.exit(main())
