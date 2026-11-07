"""Alembic environment. Schema is SQL-first (app/db/sql); revisions execute those files."""
from alembic import context
from sqlalchemy import create_engine

from app.core.config import get_settings

def run_migrations_online() -> None:
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=None, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()

if context.is_offline_mode():
    context.configure(url=get_settings().database_url, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
