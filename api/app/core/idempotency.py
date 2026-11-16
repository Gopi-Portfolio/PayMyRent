"""Safe retries. A data-entry request may carry an `Idempotency-Key` header. The first time a key is seen the work is done and its reply is
stored; a repeat of the same key (a retry after a lost reply, or the phone sending the queued entry again) returns that stored reply and does
nothing else. The same key with a DIFFERENT request is refused, so a key can never be used to slip another change through.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from collections.abc import Callable
from typing import Any
from uuid import UUID

from fastapi.encoders import jsonable_encoder
from pydantic_core import to_jsonable_python

from .db import Db
from .errors import AppError

_KEY = re.compile(r"^[A-Za-z0-9_\-]{8,80}$")


def fingerprint(method: str, path: str, body: Any) -> str:
    """What was asked, in a form that does not depend on key order or spacing."""
    payload = json.dumps(jsonable_encoder(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(f"{method.upper()} {path}\n{payload}".encode()).hexdigest()


def idempotent(db: Db, user_id: UUID, key: str | None, request_hash: str, work: Callable[[], dict]) -> dict:
    """Run `work` once per (user, key). Without a key it simply runs (old clients keep working)."""
    if not key:
        return work()
    if not _KEY.match(key):
        raise AppError("VALIDATION", "the idempotency key must be 8 to 80 letters, digits, - or _", fields=[{"field": "Idempotency-Key", "code": "invalid"}])
    # two copies of the same request arriving together are done one after the other, so the second sees the first one's reply
    db.exec("SELECT pg_advisory_xact_lock(hashtext(:k))", k=f"idem:{user_id}:{key}")
    seen = db.one("SELECT request_hash, response FROM request_idempotency WHERE user_id = :u AND key = :k", u=user_id, k=key)
    if seen is not None:
        if seen["request_hash"] != request_hash:
            raise AppError("IDEMPOTENCY_KEY_REUSED", "this key was already used for a different request")
        return seen["response"]
    out = work()
    db.exec("INSERT INTO request_idempotency(user_id, key, request_hash, response) VALUES (:u, :k, :h, CAST(:r AS jsonb))",
            u=user_id, k=key, h=request_hash, r=json.dumps(to_jsonable_python(out), ensure_ascii=False))     # the same encoding FastAPI uses for the live reply, so a replay is identical
    if random.random() < 0.02:                       # housekeeping: a key older than a month can no longer be retried by any phone
        db.exec("DELETE FROM request_idempotency WHERE created_at < now() - interval '35 days'")
    return out
