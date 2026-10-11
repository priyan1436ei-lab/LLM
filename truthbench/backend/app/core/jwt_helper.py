"""JWT issuing/verification helper with settings injection.

This is the only module besides api/deps.py that talks to the low-level JWT
functions; everything else goes through issue_jwt/read_jwt so the signing
configuration lives in exactly one place.
"""

from datetime import timedelta
from typing import Any

from app.core.config import get_settings
from app.core.security import TokenError, create_token, decode_token


def issue_jwt(
    subject: str,
    token_type: str,
    lifetime_seconds: int,
    extra: dict[str, Any] | None = None,
) -> str:
    settings = get_settings()
    return create_token(
        subject,
        token_type,
        timedelta(seconds=lifetime_seconds),
        secret=settings.secret_key,
        algorithm=settings.jwt_algorithm,
        extra=extra,
    )


def read_jwt(value: str, expected_type: str | None = None) -> dict[str, Any]:
    settings = get_settings()
    return decode_token(
        value,
        secret=settings.secret_key,
        algorithm=settings.jwt_algorithm,
        expected_type=expected_type,
    )


__all__ = ["TokenError", "issue_jwt", "read_jwt"]
