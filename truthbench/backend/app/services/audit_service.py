"""Append-only audit log service."""

import uuid

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models import AuditEvent

logger = get_logger("app.audit")


def record_audit(
    db: Session,
    *,
    action: str,
    organization_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    resource_type: str | None = None,
    resource_id: str | None = None,
    detail: dict | None = None,
    ip_address: str | None = None,
) -> AuditEvent:
    """Create an audit event. The caller owns the transaction commit."""
    event = AuditEvent(
        action=action,
        organization_id=organization_id,
        actor_user_id=actor_user_id,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id else None,
        detail=detail,
        ip_address=ip_address,
    )
    db.add(event)
    logger.info(
        "audit action=%s resource=%s/%s actor=%s",
        action,
        resource_type,
        resource_id,
        actor_user_id,
    )
    return event
