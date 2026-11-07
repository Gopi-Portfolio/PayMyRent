from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy.exc import DBAPIError

from .core.config import get_settings
from .core.db import translate_db_error
from .core.errors import AppError, app_error_handler, field_error_handler, request_validation_handler
from .core.http import BodyLimitMiddleware, RedactingFilter, RequestContextMiddleware
from .domain.validation import ValidationError
from .modules import action_otp, ai, billing, identity, jobs, kyc, notes, onboarding, owner_numbers, payments, privacy, properties, relief, subscriptions, inbox, agreements, messages, vacate, transfer


def create_app() -> FastAPI:
    s = get_settings()  # raises on unsafe production configuration
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    for h in logging.getLogger().handlers:
        h.addFilter(RedactingFilter())

    app = FastAPI(title="PayMyRent API", version="1.0.0",
                  description="Indian rental billing & collection. All money in integer paise (INR).",
                  docs_url="/docs" if s.app_env != "production" else None, redoc_url=None)
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(BodyLimitMiddleware, max_bytes=s.max_body_bytes)
    if s.allowed_hosts:
        from starlette.middleware.trustedhost import TrustedHostMiddleware
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=s.allowed_hosts)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["authorization", "content-type", "x-owner-account", "x-request-id"])
    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(ValidationError, field_error_handler)
    app.add_exception_handler(RequestValidationError, request_validation_handler)

    @app.exception_handler(DBAPIError)
    async def db_error(_: Request, exc: DBAPIError) -> JSONResponse:
        mapped = translate_db_error(exc)
        if mapped:
            return await app_error_handler(_, mapped)
        logging.getLogger("paymyrent").exception("database error")
        return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL", "message": "unexpected error"}})

    for module in (identity, subscriptions, onboarding, billing, payments, notes, ai, jobs, kyc, privacy, owner_numbers, properties, action_otp, relief, inbox, agreements, messages, vacate, transfer):
        app.include_router(module.router)

    from .providers import storage
    from .domain.signatures import verify_token

    @app.get("/api/v1/files/local/{token}", include_in_schema=False)
    def local_file(token: str) -> Response:
        claims = verify_token(s.file_signing_secret, token)
        if not claims or s.storage_backend != "local":
            raise AppError("NOT_FOUND")
        return Response(storage.read_local(s, claims["key"]), media_type="application/octet-stream")

    return app


app = create_app()
