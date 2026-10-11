"""Shared test fixtures.

The environment is pinned BEFORE any app import so that cached settings
pick up test values.
"""

import os

os.environ["TRUTHBENCH_ENVIRONMENT"] = "test"
os.environ["TRUTHBENCH_SECRET_KEY"] = "test-secret-key-not-for-production"
os.environ["TRUTHBENCH_RATE_LIMIT_ENABLED"] = "false"
os.environ["TRUTHBENCH_DATABASE_URL"] = "sqlite://"  # always overridden by fixtures

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.db.session import clear_engine_override, make_engine, override_engine


@pytest.fixture()
def engine() -> Engine:
    """Fresh in-memory SQLite with the full schema, one per test."""
    eng = make_engine("sqlite://")
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def db(engine: Engine) -> Session:
    """Direct session for service-level tests (no HTTP)."""
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(engine: Engine):
    """TestClient wired to the per-test in-memory engine."""
    from app.main import create_app

    override_engine(engine)
    application = create_app()
    with TestClient(application) as test_client:
        yield test_client
    clear_engine_override()
