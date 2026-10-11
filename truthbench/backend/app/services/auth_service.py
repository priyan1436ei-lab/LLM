"""Account service: registration, login, token issuing and refresh.

The account passphrase is received as the ``phrase`` parameter and immediately
hashed with scrypt; the raw value is never stored or logged. JWT creation and
verification are routed through app.core.jwt_helper.
"""

import re
import uuid

from sqlalchemy import select

from app.core.config import get_settings
from app.core.errors import (
    AuthenticationError,
    ConflictError,
    NotFoundError,
    ValidationFailedError,
)
from app.core.jwt_helper import issue_jwt, read_jwt
from app.core.logging import get_logger
from app.core.security import hash_password, verify_password
from app.db.base import utcnow
from app.models import Organization, User
from app.schemas.auth import IssuedAuth
from app.services.audit_service import record_audit

logger = get_logger("app.auth")

_SLUG_RE = re.compile(r"[^a-z0-9]+")

_ACCESS_TOKEN_TYPE = "access"
_RENEWAL_TOKEN_TYPE = "refresh"


def _slugify(name: str) -> str:
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug[:60] or "org"


class AuthService:
    def __init__(self, db) -> None:
        self.db = db

    # -- registration -----------------------------------------------------

    def register(
        self,
        *,
        email: str,
        phrase: str,
        display_name: str,
        organization_name: str | None = None,
        ip: str | None = None,
    ) -> User:
        existing = self.db.scalar(select(User).where(User.email == email))
        if existing is not None:
            raise ConflictError("An account with this email already exists")
        if not organization_name:
            organization_name = f"{display_name}'s workspace"
        base_slug = _slugify(organization_name)
        slug = base_slug
        while self.db.scalar(select(Organization).where(Organization.slug == slug)) is not None:
            slug = f"{base_slug}-{uuid.uuid4().hex[:6]}"
        org = Organization(name=organization_name[:200], slug=slug)
        self.db.add(org)
        self.db.flush()
        # The registering user administers their own new organization.
        user = User(
            organization_id=org.id,
            email=email,
            display_name=display_name,
            password_hash=hash_password(phrase),
            role="admin",
        )
        self.db.add(user)
        self.db.flush()
        record_audit(
            self.db,
            action="auth.register",
            organization_id=org.id,
            actor_user_id=user.id,
            resource_type="user",
            resource_id=user.id,
            ip_address=ip,
        )
        self.db.commit()
        return user

    # -- login / renewal --------------------------------------------------

    def login(self, *, email: str, phrase: str, ip: str | None = None) -> IssuedAuth:
        user = self.db.scalar(select(User).where(User.email == email))
        if user is None or user.deleted_at is not None or not verify_password(
            phrase, user.password_hash
        ):
            record_audit(
                self.db,
                action="auth.login_failed",
                organization_id=user.organization_id if user else None,
                actor_user_id=user.id if user else None,
                detail={"email": email},
                ip_address=ip,
            )
            self.db.commit()
            raise AuthenticationError("Invalid email or passphrase")
        if not user.is_active:
            raise AuthenticationError("Account is deactivated")
        user.last_login_at = utcnow()
        record_audit(
            self.db,
            action="auth.login",
            organization_id=user.organization_id,
            actor_user_id=user.id,
            resource_type="user",
            resource_id=user.id,
            ip_address=ip,
        )
        self.db.commit()
        return self.issue_auth(user)

    def refresh(self, renewal: str) -> IssuedAuth:
        payload = read_jwt(renewal, expected_type=_RENEWAL_TOKEN_TYPE)
        user = self.db.get(User, uuid.UUID(payload["sub"]))
        if user is None or user.deleted_at is not None or not user.is_active:
            raise AuthenticationError("Account not found or deactivated")
        return self.issue_auth(user)

    # -- issuing ----------------------------------------------------------

    def issue_auth(self, user: User) -> IssuedAuth:
        settings = get_settings()
        access_lifetime = settings.access_token_expire_minutes * 60
        renewal_lifetime = settings.refresh_token_expire_days * 24 * 3600
        extra = {"org": str(user.organization_id), "role": user.role, "email": user.email}
        grant = issue_jwt(
            str(user.id), _ACCESS_TOKEN_TYPE, access_lifetime, extra=extra
        )
        renewal = issue_jwt(
            str(user.id), _RENEWAL_TOKEN_TYPE, renewal_lifetime, extra=extra
        )
        return IssuedAuth(grant=grant, renewal=renewal, expires_in=access_lifetime)

    # -- admin user management ---------------------------------------------

    def create_user(
        self,
        *,
        actor: User,
        email: str,
        phrase: str,
        display_name: str,
        role: str,
    ) -> User:
        if self.db.scalar(select(User).where(User.email == email)) is not None:
            raise ConflictError("An account with this email already exists")
        user = User(
            organization_id=actor.organization_id,
            email=email,
            display_name=display_name,
            password_hash=hash_password(phrase),
            role=role,
        )
        self.db.add(user)
        self.db.flush()
        record_audit(
            self.db,
            action="user.created",
            organization_id=actor.organization_id,
            actor_user_id=actor.id,
            resource_type="user",
            resource_id=user.id,
            detail={"email": email, "role": role},
        )
        self.db.commit()
        return user

    def update_user(
        self,
        *,
        actor: User,
        target_user_id: uuid.UUID,
        display_name: str | None = None,
        role: str | None = None,
        is_active: bool | None = None,
    ) -> User:
        user = self.db.get(User, target_user_id)
        if (
            user is None
            or user.organization_id != actor.organization_id
            or user.deleted_at is not None
        ):
            raise NotFoundError("User not found")
        changes: dict = {}
        if role is not None:
            if user.id == actor.id and role != actor.role:
                raise ValidationFailedError("You cannot change your own role")
            changes["role"] = role
        if is_active is not None:
            if user.id == actor.id and not is_active:
                raise ValidationFailedError("You cannot deactivate your own account")
            changes["is_active"] = is_active
        if display_name is not None:
            changes["display_name"] = display_name
        if changes:
            for field, value in changes.items():
                setattr(user, field, value)
            record_audit(
                self.db,
                action="user.updated",
                organization_id=actor.organization_id,
                actor_user_id=actor.id,
                resource_type="user",
                resource_id=user.id,
                detail=changes,
            )
            self.db.commit()
        return user
