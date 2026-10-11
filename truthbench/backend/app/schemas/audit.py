"""Audit event schemas."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    actor_user_id: UUID | None = None
    detail: dict | None = None
    ip_address: str | None = None
    created_at: datetime
