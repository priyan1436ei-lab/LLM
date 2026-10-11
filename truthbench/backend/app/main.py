"""TruthBench AI backend — application factory."""

import time
import uuid
from contextlib import asynccontextmanager
from typing import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.errors import error_response, register_exception_handlers
from app.core.logging import configure_logging, get_logger, request_id_var
from app.db.session import init_engine

logger = get_logger("app")

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request id, adds security headers, and logs request completion."""

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = uuid.uuid4().hex[:16]
        request.state.request_id = request_id
        token = request_id_var.set(request_id)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            request_id_var.reset(token)
        duration_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = request_id
        for header, value in _SECURITY_HEADERS.items():
            response.headers[header] = value
        logger.info(
            "%s %s -> %s (%.1f ms)",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Fixed-window per-client-IP rate limiter (in-memory).

    For multi-node production deployments swap this for a Redis-backed store;
    see docs/DEPLOYMENT.md. The /api/v1/health endpoint is exempt so that
    monitors are never locked out.
    """

    def __init__(
        self,
        app: Callable,
        *,
        enabled: bool,
        requests: int,
        window_seconds: int,
        exempt_paths: tuple[str, ...] = ("/api/v1/health",),
    ) -> None:
        super().__init__(app)
        self.enabled = enabled
        self.requests = requests
        self.window_seconds = window_seconds
        self.exempt_paths = exempt_paths
        self._counts: dict[tuple[str, int], int] = {}

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if not self.enabled or request.url.path in self.exempt_paths:
            return await call_next(request)
        client_ip = request.client.host if request.client else "unknown"
        window = int(time.time() // self.window_seconds)
        key = (client_ip, window)
        count = self._counts.get(key, 0) + 1
        self._counts[key] = count
        # Garbage-collect old windows occasionally.
        if len(self._counts) > 10_000:
            self._counts = {k: v for k, v in self._counts.items() if k[1] >= window - 1}
        if count > self.requests:
            return error_response(
                request, 429, "rate_limited", "Too many requests; slow down and retry later."
            )
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(self.requests)
        response.headers["X-RateLimit-Remaining"] = str(max(0, self.requests - count))
        return response


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_engine()
        problems = settings.production_readiness_problems()
        if problems:
            raise RuntimeError("Production readiness failed: " + "; ".join(problems))
        logger.info(
            "%s v%s starting (environment=%s)", settings.app_name, settings.app_version,
            settings.environment,
        )
        yield
        logger.info("%s shutting down", settings.app_name)

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=(
            "LLM hallucination detection, RAG evaluation and benchmarking system. "
            "API version 1. Authentication uses JWT bearer tokens."
        ),
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url=f"{settings.api_v1_prefix}/openapi.json",
    )

    # Middleware: added first = innermost. CORS ends up outermost so that
    # error responses (e.g. 429) still carry CORS headers.
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        RateLimitMiddleware,
        enabled=settings.rate_limit_enabled and not settings.is_test,
        requests=settings.rate_limit_requests,
        window_seconds=settings.rate_limit_window_seconds,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_v1_prefix)
    return app


app = create_app()
