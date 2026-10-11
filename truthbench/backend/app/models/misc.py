"""Reports, API-key metadata, audit events.

The audit_events table is append-only by convention: no update or delete
endpoints exist for it. API-key metadata stores key *metadata* only — the
secrets themselves live exclusively in the environment / a secrets manager.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UUIDPrimaryKey, utcnow


class Report(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "reports"

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    report_type: Mapped[str] = mapped_column(String(30), nullable=False)  # run | job | comparison
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("evaluation_jobs.id", ondelete="SET NULL"), nullable=True
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("evaluation_runs.id", ondelete="SET NULL"), nullable=True
    )
    content_json: Mapped[dict] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ApiKeyMetadata(UUIDPrimaryKey, TimestampMixin, Base):
    __tablename__ = "api_keys_metadata"
    __table_args__ = (
        CheckConstraint(
            "status IN ('active', 'rotating', 'revoked')", name="ck_api_keys_status"
        ),
    )

    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    env_var_name: Mapped[str] = mapped_column(String(100), nullable=False)
    key_last_four: Mapped[str | None] = mapped_column(String(8), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )


class AuditEvent(UUIDPrimaryKey, Base):
    """Append-only audit log. Written by AuditService; never updated or deleted."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_org_created", "organization_id", "created_at"),
    )

    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=True
    )
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(60), index=True, nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict | None] = mapped_column(nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True, nullable=False
    )
