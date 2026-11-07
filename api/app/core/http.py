from __future__ import annotations

import logging
import random
import re
import threading
import time
import uuid
from collections import defaultdict, deque

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .errors import AppError

log = logging.getLogger("paymyrent")
_PHONE = re.compile(r"(\+?91)?[6-9]\d{9}")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def redact(s: str) -> str:
    """Safe logging: mask Indian mobile numbers and emails anywhere in a log line."""
    s = _PHONE.sub(lambda m: m.group(0)[:-10] + "******" + m.group(0)[-4:], s)
    return _EMAIL.sub("***@***", s)


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(str(record.msg))
        if isinstance(record.args, tuple):      # mask text only; numbers must stay numbers or "%d" / "%.0f" formatting fails
            record.args = tuple(redact(a) if isinstance(a, str) else a for a in record.args)
        return True


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # noqa: ANN001
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        response.headers["strict-transport-security"] = "max-age=31536000; includeSubDomains"
        response.headers["x-content-type-options"] = "nosniff"
        response.headers["x-frame-options"] = "DENY"
        response.headers["referrer-policy"] = "no-referrer"
        response.headers["cache-control"] = response.headers.get("cache-control", "no-store")
        log.info("%s %s %s %.0fms rid=%s", request.method, request.url.path, response.status_code,
                 (time.perf_counter() - start) * 1000, rid)
        return response


class RateLimiter:
    """Sliding window kept in PostgreSQL so every API instance shares the same counters and a restart does not reset them.
    Falls back to per-process memory only if the database call itself fails (never blocks a request because of the limiter)."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _check_memory(self, key: str, limit: int, window_s: int) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window_s:
                q.popleft()
            if len(q) >= limit:
                raise AppError("RATE_LIMITED", "too many requests; try again shortly", retry_after=int(window_s - (now - q[0])) + 1)
            q.append(now)
            if len(self._hits) > 5000:                      # keep memory bounded: drop idle keys
                for k in [k for k, v in self._hits.items() if not v or v[-1] <= now - 3600]:
                    self._hits.pop(k, None)

    def check(self, key: str, limit: int, window_s: int) -> None:
        from sqlalchemy import text

        from .db import engine
        try:
            with engine().begin() as c:
                c.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": key})
                rows = c.execute(text("""SELECT count(*), min(hit_at), extract(epoch FROM now() - min(hit_at))
                                         FROM rate_limit_hits WHERE key = :k AND hit_at > clock_timestamp() - make_interval(secs => :w)"""),
                                 {"k": key, "w": window_s}).one()
                if rows[0] >= limit:
                    raise AppError("RATE_LIMITED", "too many requests; try again shortly", retry_after=max(1, int(window_s - float(rows[2] or 0)) + 1))
                c.execute(text("INSERT INTO rate_limit_hits(key) VALUES (:k)"), {"k": key})
                if random.random() < 0.01:                  # housekeeping: forget anything older than a day
                    c.execute(text("DELETE FROM rate_limit_hits WHERE hit_at < clock_timestamp() - interval '1 day'"))
        except AppError:
            raise
        except Exception:  # noqa: BLE001 - the limiter must not take the API down
            log.exception("rate limiter database error; using in-memory fallback")
            self._check_memory(key, limit, window_s)


limiter = RateLimiter()


class BodyLimitMiddleware:
    """Pure ASGI: rejects oversized bodies by Content-Length and while streaming, before they are buffered in memory."""

    def __init__(self, app, max_bytes: int) -> None:  # noqa: ANN001
        self.app, self.max = app, max_bytes

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        cl = headers.get(b"content-length")
        too_big = False
        if cl is not None:
            try:
                too_big = int(cl) > self.max
            except ValueError:
                too_big = True
        if too_big:
            return await self._reject(send)
        seen = 0

        async def limited_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.max:
                    raise _TooLarge
            return msg
        try:
            await self.app(scope, limited_receive, send)
        except _TooLarge:
            await self._reject(send)

    @staticmethod
    async def _reject(send) -> None:  # noqa: ANN001
        body = b'{"error":{"code":"PAYLOAD_TOO_LARGE","message":"request is too large"}}'
        await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass
