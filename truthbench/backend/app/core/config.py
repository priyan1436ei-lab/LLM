"""Application configuration.

All configuration is environment-driven via the ``TRUTHBENCH_`` prefix.
Secrets are only ever read from the environment; they are never sent to the
browser, never logged, and never stored in database tables.
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

_DEV_SECRET = "dev-insecure-secret-key-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="TRUTHBENCH_",
        extra="ignore",
    )

    app_name: str = "TruthBench AI"
    app_version: str = "0.1.0"
    # development | test | production
    environment: str = "development"
    api_v1_prefix: str = "/api/v1"

    # Database. SQLite for local development; PostgreSQL in production
    # (see production_readiness_problems()).
    database_url: str = "sqlite:///./truthbench.db"

    # Auth
    secret_key: str = _DEV_SECRET
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # CORS (comma-separated origins)
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Rate limiting (fixed window, per client IP, in-memory)
    rate_limit_enabled: bool = True
    rate_limit_requests: int = 300
    rate_limit_window_seconds: int = 60

    # Uploads
    upload_max_bytes: int = 20 * 1024 * 1024

    # Background worker / benchmark runner
    worker_enabled: bool = True
    worker_poll_interval_seconds: float = 2.0
    benchmark_max_concurrency: int = 4
    benchmark_example_timeout_seconds: float = 120.0
    benchmark_max_retries: int = 2

    # Logging
    log_level: str = "INFO"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def is_test(self) -> bool:
        return self.environment == "test"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def production_readiness_problems(self) -> list[str]:
        """Configuration problems that make the current settings unsafe for production."""
        problems: list[str] = []
        if not self.is_production:
            return problems
        if self.secret_key == _DEV_SECRET:
            problems.append("TRUTHBENCH_SECRET_KEY must be set to a strong random value")
        if not self.database_url.startswith("postgresql"):
            problems.append(
                "TRUTHBENCH_DATABASE_URL must point at PostgreSQL in production "
                "(SQLite is for local development only)"
            )
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()
