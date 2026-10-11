"""Password hashing (scrypt, from the standard library) and JWT helpers.

Password format: ``scrypt$N$r$p$<salt_b64>$<hash_b64>`` — versioned so the
parameters can be raised later without invalidating existing hashes.
"""

import base64
import hashlib
import hmac
import secrets
from datetime import timedelta
from datetime import datetime, timezone
from typing import Any

import jwt

_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1
_KEY_LEN = 32


class TokenError(Exception):
    """Raised when a token is invalid, expired, or of the wrong type."""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=_SCRYPT_N,
        r=_SCRYPT_R,
        p=_SCRYPT_P,
        dklen=_KEY_LEN,
    )
    return "$".join(
        [
            "scrypt",
            str(_SCRYPT_N),
            str(_SCRYPT_R),
            str(_SCRYPT_P),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt_b64, hash_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(base64.b64decode(hash_b64)),
        )
        return hmac.compare_digest(digest, base64.b64decode(hash_b64))
    except Exception:
        return False


def create_token(
    subject: str,
    token_type: str,
    expires_delta: timedelta,
    *,
    secret: str,
    algorithm: str = "HS256",
    extra: dict[str, Any] | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "jti": secrets.token_hex(8),
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, secret, algorithm=algorithm)


def decode_token(
    token: str,
    *,
    secret: str,
    algorithm: str = "HS256",
    expected_type: str | None = None,
) -> dict[str, Any]:
    try:
        payload: dict[str, Any] = jwt.decode(token, secret, algorithms=[algorithm])
    except jwt.InvalidTokenError as exc:
        raise TokenError("Invalid or expired token") from exc
    if expected_type is not None and payload.get("type") != expected_type:
        raise TokenError("Invalid token type")
    return payload
