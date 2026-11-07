"""Authentication (Firebase ID tokens; dev simulator in non-production) and scope helpers.

The internal users.id UUID is the only key used in relationships. Firebase UID and phone
numbers are looked up, never used as foreign keys.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, Header

from .config import get_settings
from .db import Db, get_db
from .errors import AppError

_GOOGLE_CERTS = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
_cert_cache: dict = {"exp": 0.0, "keys": {}}


@dataclass(frozen=True)
class Identity:
    firebase_uid: str
    phone: str | None
    issued_at: int
    is_dev: bool


def _google_keys() -> dict[str, str]:
    if _cert_cache["exp"] > time.time():
        return _cert_cache["keys"]
    r = httpx.get(_GOOGLE_CERTS, timeout=5)
    r.raise_for_status()
    max_age = 3600
    for part in r.headers.get("cache-control", "").split(","):
        if part.strip().startswith("max-age="):
            max_age = int(part.split("=")[1])
    _cert_cache.update(exp=time.time() + max_age, keys=r.json())
    return _cert_cache["keys"]


def verify_firebase_token(token: str) -> Identity:
    s = get_settings()
    try:
        kid = jwt.get_unverified_header(token).get("kid")
        cert = _google_keys().get(kid or "")
        if not cert:
            raise AppError("UNAUTHENTICATED", "unknown signing key")
        from cryptography.x509 import load_pem_x509_certificate
        public_key = load_pem_x509_certificate(cert.encode()).public_key()
        claims = jwt.decode(token, public_key, algorithms=["RS256"], audience=s.firebase_project_id,
                            issuer=f"https://securetoken.google.com/{s.firebase_project_id}",
                            options={"require": ["exp", "iat", "sub", "auth_time"]}, leeway=30)
    except jwt.PyJWTError as e:
        raise AppError("UNAUTHENTICATED", "invalid or expired token") from e
    if not claims.get("sub"):
        raise AppError("UNAUTHENTICATED", "invalid token subject")
    return Identity(claims["sub"], claims.get("phone_number"), int(claims["iat"]), False)


def issue_dev_token(phone: str, uid: str | None = None) -> str:
    s = get_settings()
    if not s.dev_auth_enabled or s.app_env == "production":
        raise AppError("FORBIDDEN", "dev auth disabled")
    now = int(time.time())
    return jwt.encode({"sub": uid or f"dev:{phone}", "phone_number": phone, "iat": now, "exp": now + 7 * 24 * 3600,
                       "iss": "paymyrent-dev"}, s.dev_jwt_secret, algorithm="HS256")


def verify_token(authorization: str | None) -> Identity:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AppError("UNAUTHENTICATED", "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    s = get_settings()
    if s.dev_auth_enabled and s.app_env != "production":
        try:
            claims = jwt.decode(token, s.dev_jwt_secret, algorithms=["HS256"], issuer="paymyrent-dev")
            return Identity(claims["sub"], claims.get("phone_number"), int(claims["iat"]), True)
        except jwt.PyJWTError:
            pass  # fall through to Firebase verification
    if not s.firebase_project_id:
        raise AppError("UNAUTHENTICATED", "invalid token")
    return verify_firebase_token(token)


@dataclass(frozen=True)
class CurrentUser:
    id: UUID
    identity: Identity
    roles: frozenset[str]
    language: str
    profile_complete: bool


def identity_dep(authorization: str | None = Header(default=None)) -> Identity:
    return verify_token(authorization)


APP_LANGUAGES = frozenset({"en", "ta", "hi", "te", "kn", "ml", "mr", "bn"})


def current_user(identity: Identity = Depends(identity_dep), db: Db = Depends(get_db),
                 x_app_language: str | None = Header(default=None)) -> CurrentUser:
    row = db.one("""SELECT u.id, u.status, u.preferred_language, u.sessions_valid_after, u.profile_completed_at,
                           COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
                           (SELECT COALESCE(array_agg(m.owner_account_id::text), '{}') FROM owner_memberships m WHERE m.user_id = u.id AND m.status = 'active') AS owner_ids,
                           (SELECT COALESCE(array_agg(c.value), '{}') FROM user_contacts c WHERE c.user_id = u.id AND c.kind = 'mobile'
                                   AND c.verified_at IS NOT NULL AND c.removed_at IS NULL) AS phones
                    FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
                    WHERE u.firebase_uid = :uid GROUP BY u.id""", uid=identity.firebase_uid)
    if row is None:
        raise AppError("UNAUTHENTICATED", "no session; call POST /api/v1/auth/session first")
    if row["status"] != "active":
        raise AppError("FORBIDDEN", "account is not active")
    # Whole-second comparison (token iat has 1 s resolution), as Firebase does for revocation.
    if identity.issued_at < int(row["sessions_valid_after"].timestamp()):
        raise AppError("UNAUTHENTICATED", "session revoked; sign in again")
    # row-level security: from here on the database only shows this person's own owner account(s) and the tenancies they rent
    db.ctx(user_id=row["id"], owner_ids=list(row["owner_ids"]), phones=list(row["phones"]), tenancy_ids=[])
    # the tenancies this person rents (or has an open invitation to), computed once so every row-level rule is an index lookup
    rented = db.scalar("""SELECT COALESCE(array_agg(t.id::text), '{}') FROM tenancies t WHERE t.tenant_user_id = :u
                          OR (t.status = 'invited' AND t.tenant_user_id IS NULL AND t.invited_phone = ANY(:p))""", u=row["id"], p=list(row["phones"]))
    db.ctx(tenancy_ids=list(rented))
    # Text made while answering a request (bell items, updates, statements) is in the language the app is showing right now. The stored
    # preference is only for messages sent to this person later (SMS, WhatsApp), so an old choice can no longer override the screen.
    shown = (x_app_language or "").strip().lower()
    language = shown if shown in APP_LANGUAGES else row["preferred_language"]
    return CurrentUser(row["id"], identity, frozenset(row["roles"]), language,
                       row["profile_completed_at"] is not None)


def complete_user(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    if not user.profile_complete:
        raise AppError("PROFILE_INCOMPLETE", "complete your profile first")
    return user


@dataclass(frozen=True)
class OwnerScope:
    user: CurrentUser
    owner_account_id: UUID
    membership_role: str


def owner_scope(user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db),
                x_owner_account: UUID | None = Header(default=None)) -> OwnerScope:
    """Resolve the owner account the caller may act for. Never trusts a client-sent id
    without checking membership; role intent alone grants nothing."""
    rows = db.all("""SELECT owner_account_id, role FROM owner_memberships
                     WHERE user_id = :u AND status = 'active'""", u=user.id)
    if not rows:
        raise AppError("FORBIDDEN", "owner account required")
    if x_owner_account is None:
        own = next((r for r in rows if r["role"] == "owner"), rows[0])
        db.ctx(owner_ids=[own["owner_account_id"]])          # acting for exactly one account at a time
        return OwnerScope(user, own["owner_account_id"], own["role"])
    match = next((r for r in rows if r["owner_account_id"] == x_owner_account), None)
    if match is None:
        raise AppError("NOT_FOUND", "owner account not found")
    db.ctx(owner_ids=[match["owner_account_id"]])
    return OwnerScope(user, match["owner_account_id"], match["role"])


def owned_tenancy(db: Db, scope: OwnerScope, tenancy_id: UUID, lock: bool = False) -> dict:
    row = db.one(f"""SELECT * FROM tenancies WHERE id = :t AND owner_account_id = :o {'FOR UPDATE' if lock else ''}""",
                 t=tenancy_id, o=scope.owner_account_id)
    if row is None:
        raise AppError("NOT_FOUND", "tenancy not found")
    return dict(row)


def tenant_tenancy(db: Db, user: CurrentUser, tenancy_id: UUID) -> dict:
    """A tenant sees a tenancy only after accepting it; ended tenancies stay visible as history."""
    row = db.one("""SELECT * FROM tenancies WHERE id = :t AND tenant_user_id = :u AND status IN ('active','ended')""",
                 t=tenancy_id, u=user.id)
    if row is None:
        raise AppError("NOT_FOUND", "tenancy not found")
    return dict(row)


def tenancy_party(db: Db, user: CurrentUser, tenancy_id: UUID) -> tuple[dict, str, UUID | None]:
    """Return (tenancy, role, owner_account_id) for a user who is the tenant OR an owner member."""
    row = db.one("""SELECT t.*, (t.tenant_user_id = :u AND t.status IN ('active','ended')) AS is_tenant,
                           EXISTS (SELECT 1 FROM owner_memberships m WHERE m.owner_account_id = t.owner_account_id
                                    AND m.user_id = :u AND m.status = 'active') AS is_owner
                    FROM tenancies t WHERE t.id = :t""", t=tenancy_id, u=user.id)
    if row is None or not (row["is_owner"] or row["is_tenant"]):
        raise AppError("NOT_FOUND", "tenancy not found")
    role = "owner" if row["is_owner"] else "tenant"
    return dict(row), role, row["owner_account_id"] if role == "owner" else None
