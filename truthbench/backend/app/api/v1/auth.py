"""Authentication endpoints."""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import User
from app.schemas.auth import (
    IssuedAuth,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    RegisterResponse,
    UserOut,
)
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post("/register", response_model=RegisterResponse, status_code=201)
def register(
    payload: RegisterRequest, request: Request, db: Session = Depends(get_db)
) -> RegisterResponse:
    service = AuthService(db)
    user = service.register(
        email=payload.email,
        phrase=payload.passphrase,
        display_name=payload.display_name,
        organization_name=payload.organization_name,
        ip=_client_ip(request),
    )
    auth = service.issue_auth(user)
    return RegisterResponse(user=UserOut.model_validate(user), auth=auth)


@router.post("/login", response_model=IssuedAuth)
def login(payload: LoginRequest, request: Request, db: Session = Depends(get_db)) -> IssuedAuth:
    return AuthService(db).login(
        email=payload.email, phrase=payload.passphrase, ip=_client_ip(request)
    )


@router.post("/refresh", response_model=IssuedAuth)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> IssuedAuth:
    return AuthService(db).refresh(payload.renewal)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user
