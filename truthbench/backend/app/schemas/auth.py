"""Authentication and user schemas.

Wire-format keys (documented in the API contract): ``passphrase`` for the
account secret on register/login, ``grant`` and ``renewal`` for the issued JWT
pair, ``expires_in`` for the access-token lifetime in seconds.
"""

import re
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
# Obviously weak values that must never be accepted as real account passphrases.
_AUTH_PHRASE_BLOCKLIST = {
    "password",
    "password1",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwertyuiop",
    "letmein123",
    "truthbench",
}


def _normalize_email(v: str) -> str:
    v = v.strip().lower()
    if not _EMAIL_RE.match(v):
        raise ValueError("invalid email address")
    return v


def _validate_passphrase(v: str) -> str:
    if len(v) < 10:
        raise ValueError("passphrase must be at least 10 characters")
    if len(v) > 128:
        raise ValueError("passphrase must be at most 128 characters")
    if v.lower() in _AUTH_PHRASE_BLOCKLIST:
        raise ValueError("this passphrase is too common; choose a stronger one")
    return v


class RegisterRequest(BaseModel):
    email: str
    passphrase: str
    display_name: str = Field(min_length=1, max_length=120)
    organization_name: str | None = Field(default=None, max_length=200)

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _normalize_email(v)

    @field_validator("passphrase")
    @classmethod
    def check_phrase_strength(cls, v: str) -> str:
        return _validate_passphrase(v)


class LoginRequest(BaseModel):
    email: str
    passphrase: str

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _normalize_email(v)


class RefreshRequest(BaseModel):
    renewal: str


class IssuedAuth(BaseModel):
    grant: str  # short-lived access JWT
    renewal: str  # long-lived renewal JWT
    expires_in: int  # access JWT lifetime in seconds


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    display_name: str
    role: str
    organization_id: UUID
    is_active: bool
    created_at: datetime


class RegisterResponse(BaseModel):
    user: UserOut
    auth: IssuedAuth


class UserCreateRequest(BaseModel):
    email: str
    passphrase: str
    display_name: str = Field(min_length=1, max_length=120)
    role: str = Field(pattern="^(admin|researcher|viewer)$")

    @field_validator("email")
    @classmethod
    def check_email(cls, v: str) -> str:
        return _normalize_email(v)

    @field_validator("passphrase")
    @classmethod
    def check_phrase_strength(cls, v: str) -> str:
        return _validate_passphrase(v)


class UserPatchRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    role: str | None = Field(default=None, pattern="^(admin|researcher|viewer)$")
    is_active: bool | None = None
