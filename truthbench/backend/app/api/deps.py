"""Request dependencies: authentication, authorization, tenant scoping."""

import uuid

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AuthenticationError, PermissionDeniedError
from app.core.security import TokenError, decode_token
from app.db.session import get_db
from app.models import User

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationError("Missing bearer token")
    settings = get_settings()
    try:
        payload = decode_token(
            credentials.credentials,
            secret=settings.secret_key,
            algorithm=settings.jwt_algorithm,
            expected_type="access",
        )
    except TokenError as exc:
        raise AuthenticationError("Invalid or expired token") from exc
    user = db.get(User, uuid.UUID(payload["sub"]))
    if user is None or user.deleted_at is not None or not user.is_active:
        raise AuthenticationError("Account not found or deactivated")
    return user


def require_roles(*roles: str):
    """Dependency factory: allow only the given roles."""

    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise PermissionDeniedError(
                f"This action requires one of roles: {', '.join(roles)}"
            )
        return user

    return dependency
