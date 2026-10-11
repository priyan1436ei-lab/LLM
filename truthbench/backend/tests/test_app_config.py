"""Configuration behaviour tests."""

from app.core.config import Settings


def test_dev_defaults_are_not_production_ready(monkeypatch):
    # The test env pins TRUTHBENCH_SECRET_KEY; remove it so the insecure default applies.
    monkeypatch.delenv("TRUTHBENCH_SECRET_KEY", raising=False)
    settings = Settings(environment="production", database_url="sqlite:///./x.db")
    problems = settings.production_readiness_problems()
    assert any("SECRET_KEY" in p for p in problems)
    assert any("PostgreSQL" in p for p in problems)


def test_production_config_has_no_problems():
    settings = Settings(
        environment="production",
        database_url="postgresql://tb:tb@localhost/tb",
        secret_key="a-real-random-secret-value-123",
    )
    assert settings.production_readiness_problems() == []


def test_non_production_never_blocks():
    settings = Settings(environment="development")
    assert settings.production_readiness_problems() == []
