"""Stable error codes → HTTP status. Clients translate `code`; `message` is English fallback."""
from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..domain.validation import ValidationError

STATUS = {
    "VALIDATION": 422, "NOT_FOUND": 404, "FORBIDDEN": 403, "UNAUTHENTICATED": 401,
    "SUBSCRIPTION_REQUIRED": 402, "UNIT_CAPACITY_EXCEEDED": 409, "UNIT_HAS_LIVE_TENANCY": 409,
    "IMMUTABLE_RECORD": 409, "INVALID_STATE": 409, "IDEMPOTENCY_KEY_REUSED": 409, "CONFLICT": 409,
    "TENANCY_NOT_ACTIVE": 409, "DEPOSIT_INSUFFICIENT": 409, "CONTACT_LIMIT": 409, "SCOPE_VIOLATION": 404,
    "INVOICE_VOID": 409, "RATE_LIMITED": 429, "PROFILE_INCOMPLETE": 409, "PHONE_IN_USE": 409,
    "AI_SUBSCRIPTION_INACTIVE": 402, "AI_FEATURE_NOT_IN_PLAN": 402, "AI_MODEL_NOT_ALLOWED": 400,
    "AI_REQUEST_TOO_LARGE": 413, "AI_QUOTA_EXHAUSTED": 429, "AI_COST_CEILING_REACHED": 429,
    "AI_VOICE_QUOTA_EXHAUSTED": 429, "AI_TOO_MANY_CONCURRENT": 429, "AI_DISABLED": 503,
    "PAYMENTS_UNAVAILABLE": 503, "OWNER_DETAILS_REQUIRED": 409, "KYC_UNAVAILABLE": 503, "IDENTITY_REQUIRED": 409, "PROVIDER_ERROR": 502, "STALE_VERSION": 409, "IMPORT_FILE": 422,
    "PROPERTY_NEEDS_SUBSCRIPTION": 409, "PROPERTY_NOT_VERIFIED": 409, "PROPERTY_ALREADY_REGISTERED": 409, "PROPERTY_PROOF_ALREADY_USED": 409, "DEED_ADDRESS_MISMATCH": 422,
}


class AppError(Exception):
    def __init__(self, code: str, message: str = "", status: int | None = None, **details: object) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code.replace("_", " ").lower()
        self.status = status or STATUS.get(code, 400)
        self.details = details


def from_db_message(msg: str) -> AppError | None:
    """Map 'CODE: detail' raised by PL/pgSQL (ERRCODE P0001) to an AppError."""
    head, _, detail = msg.partition(":")
    code = head.strip()
    if code in STATUS or code.startswith("AI_"):
        return AppError(code, detail.strip() or code)
    return None


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    error = {"code": exc.code, "message": exc.message, "details": exc.details}
    if isinstance(exc.details.get("fields"), list):
        error["fields"] = exc.details["fields"]          # the app reads field-level messages from here, same as for validation errors
    return JSONResponse(status_code=exc.status, content={"error": error})


async def field_error_handler(_: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "invalid field",
                                                            "fields": [{"field": exc.field, "code": exc.code, **exc.params}]}})


async def request_validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields = [{"field": ".".join(str(p) for p in e["loc"][1:]), "code": e["type"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "invalid request", "fields": fields}})
