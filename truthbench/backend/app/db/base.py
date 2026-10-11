"""Declarative base and shared column mixins."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Uuid
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    # Map bare dict/list annotations to JSON columns (portable across
    # SQLite and PostgreSQL).
    type_annotation_map = {
        dict: JSON,
        list: JSON,
    }


class UUIDPrimaryKey:
    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class SoftDeleteMixin:
    """Soft deletion for entities where history matters (users, datasets, models)."""

    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None, nullable=True, index=True
    )
