"""Database migration tests: the Alembic chain must produce the full schema."""

import os

import sqlalchemy
from alembic import command
from alembic.config import Config


def test_upgrade_head_creates_every_table(tmp_path):
    db_file = tmp_path / "migration_test.db"
    os.environ["TRUTHBENCH_DATABASE_URL"] = f"sqlite:///{db_file}"
    try:
        cfg = Config("alembic.ini")
        command.upgrade(cfg, "head")
    finally:
        os.environ.pop("TRUTHBENCH_DATABASE_URL", None)

    engine = sqlalchemy.create_engine(f"sqlite:///{db_file}")
    try:
        inspector = sqlalchemy.inspect(engine)
        tables = set(inspector.get_table_names())
        from app.db.base import Base

        expected = set(Base.metadata.tables.keys()) | {"alembic_version"}
        missing = expected - tables
        assert not missing, f"tables missing after upgrade head: {sorted(missing)}"
    finally:
        engine.dispose()


def test_downgrade_to_base_drops_everything(tmp_path):
    db_file = tmp_path / "migration_down_test.db"
    os.environ["TRUTHBENCH_DATABASE_URL"] = f"sqlite:///{db_file}"
    try:
        cfg = Config("alembic.ini")
        command.upgrade(cfg, "head")
        command.downgrade(cfg, "base")
    finally:
        os.environ.pop("TRUTHBENCH_DATABASE_URL", None)

    engine = sqlalchemy.create_engine(f"sqlite:///{db_file}")
    try:
        tables = set(sqlalchemy.inspect(engine).get_table_names())
        # Alembic never drops its own bookkeeping table — that is expected.
        assert tables <= {"alembic_version"}, (
            f"application tables survived downgrade: {sorted(tables - {'alembic_version'})}"
        )
    finally:
        engine.dispose()
