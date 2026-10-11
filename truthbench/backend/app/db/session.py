"""Engine and session management with a test override hook."""

from collections.abc import Iterator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings

_engine: Engine | None = None
_session_factory: sessionmaker | None = None


def make_engine(database_url: str) -> Engine:
    if database_url.startswith("sqlite"):
        kwargs: dict = {"connect_args": {"check_same_thread": False}}
        if database_url in ("sqlite://", "sqlite:///:memory:") or "mode=memory" in database_url:
            kwargs["poolclass"] = StaticPool
        return create_engine(database_url, pool_pre_ping=True, **kwargs)
    return create_engine(database_url, pool_pre_ping=True)


def init_engine(database_url: str | None = None) -> Engine:
    """Initialise the global engine (no-op if already initialised)."""
    global _engine, _session_factory
    if _engine is not None:
        return _engine
    url = database_url or get_settings().database_url
    _engine = make_engine(url)
    _session_factory = sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)
    return _engine


def override_engine(engine: Engine) -> None:
    """Test hook: force a specific engine (e.g. shared in-memory SQLite)."""
    global _engine, _session_factory
    _engine = engine
    _session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def clear_engine_override() -> None:
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None


def get_session() -> Session:
    init_engine()
    assert _session_factory is not None
    return _session_factory()


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request. Services own commits."""
    db = get_session()
    try:
        yield db
    finally:
        db.close()
