"""Webhook signature verification and short-lived signed tokens (job triggers, downloads)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


def hmac_sha256_hex(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def verify_hmac_sha256_hex(secret: str, body: bytes, signature: str | None) -> bool:
    """Razorpay-style webhook check: hex HMAC-SHA256 of the *raw* request body.

    Always computed over the exact bytes received — never a re-serialised JSON.
    """
    if not secret or not signature:
        return False
    return hmac.compare_digest(hmac_sha256_hex(secret, body), signature.strip())


def sign_token(secret: str, payload: dict, ttl_seconds: int) -> str:
    body = dict(payload, exp=int(time.time()) + ttl_seconds)
    raw = base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":"), sort_keys=True).encode()).rstrip(b"=")
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), raw, hashlib.sha256).digest()).rstrip(b"=")
    return f"{raw.decode()}.{sig.decode()}"


def verify_token(secret: str, token: str) -> dict | None:
    try:
        raw, sig = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), raw.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        if not hmac.compare_digest(expected, sig):
            return None
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if int(body.get("exp", 0)) < time.time():
            return None
        return body
    except (ValueError, json.JSONDecodeError):
        return None


def hash_otp(secret: str, target: str, code: str) -> str:
    """OTPs are stored only as a keyed hash bound to the target number/email."""
    return hmac.new(secret.encode(), f"{target}:{code}".encode(), hashlib.sha256).hexdigest()


def mask_phone(e164: str | None) -> str:
    if not e164:
        return ""
    return e164[:3] + "•••••" + e164[-4:] if len(e164) >= 8 else "•••"


def mask_email(email: str | None) -> str:
    if not email or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    return (local[:1] + "•••" + "@" + domain) if local else "•••@" + domain
