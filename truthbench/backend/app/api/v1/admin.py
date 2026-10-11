"""Administration endpoints: user management and audit log."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import require_roles
from app.core.pagination import PageParams, page_params, paginate
from app.db.session import get_db
from app.models import AuditEvent, User
from app.schemas.audit import AuditEventOut
from app.schemas.auth import UserCreateRequest, UserOut, UserPatchRequest
from app.schemas.common import Paginated
from app.services.auth_service import AuthService

router = APIRouter(prefix="/admin", tags=["administration"])


@router.get("/users", response_model=Paginated[UserOut], summary="List organization users")
def list_users(
    params: PageParams = Depends(page_params),
    role: str | None = Query(default=None, pattern="^(admin|researcher|viewer)$"),
    db: Session = Depends(get_db),
    admin: User = Depends(require_roles("admin")),
) -> Paginated[UserOut]:
    stmt = select(User).where(
        User.organization_id == admin.organization_id,
        User.deleted_at.is_(None),
    )
    if role:
        stmt = stmt.where(User.role == role)
    stmt = stmt.order_by(User.created_at.desc())
    users, total = paginate(db, stmt, params)
    items = [UserOut.model_validate(u) for u in users]
    return Paginated[UserOut].build(items, total, params.page, params.size)


@router.post("/users", response_model=UserOut, status_code=201, summary="Create a user")
def create_user(
    payload: UserCreateRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_roles("admin")),
) -> UserOut:
    user = AuthService(db).create_user(
        actor=admin,
        email=payload.email,
        phrase=payload.passphrase,
        display_name=payload.display_name,
        role=payload.role,
    )
    return UserOut.model_validate(user)


@router.patch("/users/{user_id}", response_model=UserOut, summary="Update a user")
def update_user(
    user_id: uuid.UUID,
    payload: UserPatchRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_roles("admin")),
) -> UserOut:
    user = AuthService(db).update_user(
        actor=admin,
        target_user_id=user_id,
        display_name=payload.display_name,
        role=payload.role,
        is_active=payload.is_active,
    )
    return UserOut.model_validate(user)


@router.get("/audit", response_model=Paginated[AuditEventOut], summary="Audit log (org-scoped)")
def list_audit(
    params: PageParams = Depends(page_params),
    action: str | None = Query(default=None, max_length=60),
    db: Session = Depends(get_db),
    admin: User = Depends(require_roles("admin")),
) -> Paginated[AuditEventOut]:
    stmt = select(AuditEvent).where(AuditEvent.organization_id == admin.organization_id)
    if action:
        stmt = stmt.where(AuditEvent.action == action)
    stmt = stmt.order_by(AuditEvent.created_at.desc())
    events, total = paginate(db, stmt, params)
    items = [AuditEventOut.model_validate(e) for e in events]
    return Paginated[AuditEventOut].build(items, total, params.page, params.size)
