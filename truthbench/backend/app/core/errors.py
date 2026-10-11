"""Consistent API error envelope and exception handlers.

Every error response has the shape::

    {"error": {"code": "...", "message": "...", "details": {...}}, "request_id": "..."}
"""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

logger = get_logger("app.errors")


class AppError(Exception):
    """Base class for expected application errors."""

    status_code = 400
    code = "bad_request"

    def __init__(
        self,
        message: str | None = None,
        *,
        details: dict[str, Any] | None = None,
        status_code: int | None = None,
        code: str | None = None,
    ) -> None:
        self.message = message or self.__class__.__name__
        self.details = details or {}
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        super().__init__(self.message)


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class ValidationFailedError(AppError):
    status_code = 422
    code = "validation_failed"


class AuthenticationError(AppError):
    status_code = 401
    code = "not_authenticated"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "permission_denied"


class RateLimitedError(AppError):
    status_code = 429
    code = "rate_limited"


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "payload_too_large"


class ExternalServiceError(AppError):
    status_code = 502
    code = "external_service_error"


_STATUS_CODES = {
    400: "bad_request",
    401: "not_authenticated",
    403: "permission_denied",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    422: "validation_error",
    429: "rate_limited",
}


def error_response(
    request: Request | None,
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    request_id = getattr(getattr(request, "state", None), "request_id", None) or "-"
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {"code": code, "message": message, "details": jsonable_encoder(details or {})},
            "request_id": request_id,
        },
    )


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        return error_response(request, exc.status_code, exc.code, exc.message, exc.details)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "http_error")
        return error_response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(
            request,
            422,
            "validation_error",
            "Request validation failed",
            {"errors": jsonable_encoder(exc.errors()[:20])},
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        return error_response(request, 500, "internal_error", "An internal error occurred.")
