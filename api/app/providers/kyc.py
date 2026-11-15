"""Identity-verification (eKYC) provider adapters.

The real flow is delegated to a licensed provider (government ID via DigiLocker / Aadhaar eKYC, a liveness selfie,
and face + name match). RentMeezy never performs face matching itself and never stores ID numbers, ID images or
selfies — only the outcome flags below. Connect a provider by implementing `KycProvider` and selecting it with
RG_KYC_PROVIDER; until then `SandboxKyc` simulates outcomes for local demos and `NotConfiguredKyc` refuses.
"""
from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from typing import Protocol

from ..core.config import Settings
from ..core.errors import AppError
from ..domain.signatures import hmac_sha256_hex, verify_hmac_sha256_hex


@dataclass(frozen=True)
class KycSession:
    provider: str
    session_id: str
    client: dict            # what the app needs (hosted URL, SDK token, …)


@dataclass(frozen=True)
class KycResult:
    status: str             # 'verified' | 'failed' | 'manual_review' | 'pending'
    method: str | None = None
    liveness_passed: bool | None = None
    face_matched: bool | None = None
    name_matched: bool | None = None


class KycProvider(Protocol):
    name: str
    is_demo: bool

    def create_session(self, *, user_id: str, full_name: str | None) -> KycSession: ...
    def fetch_result(self, session_id: str) -> KycResult: ...
    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> tuple[str, KycResult]: ...


class SandboxKyc:
    """Demo adapter: nothing real is checked. The sandbox page posts a signed result through the same webhook path."""
    name, is_demo = "sandbox", True

    def __init__(self, secret: str, base_url: str) -> None:
        self.secret, self.base_url = secret, base_url

    def create_session(self, *, user_id: str, full_name: str | None) -> KycSession:
        sid = "sbx_kyc_" + secrets.token_hex(8)
        return KycSession(self.name, sid, {"mode": "sandbox", "demo": True, "url": f"{self.base_url}/api/v1/sandbox/kyc/{sid}"})

    def fetch_result(self, session_id: str) -> KycResult:
        return KycResult("pending")           # the database is the source of truth; results arrive via the webhook

    def build_event(self, session_id: str, outcome: str) -> bytes:
        ok = outcome == "verified"
        return json.dumps({"session_id": session_id, "status": outcome, "method": "sandbox",
                           "liveness_passed": ok or outcome == "manual_review", "face_matched": ok or None,
                           "name_matched": ok or None}).encode()

    def sign(self, body: bytes) -> str:
        return hmac_sha256_hex(self.secret, body)

    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> tuple[str, KycResult]:
        if not verify_hmac_sha256_hex(self.secret, body, headers.get("x-kyc-signature")):
            raise AppError("FORBIDDEN", "invalid webhook signature")
        d = json.loads(body)
        return d["session_id"], KycResult(d["status"], d.get("method"), d.get("liveness_passed"), d.get("face_matched"), d.get("name_matched"))


class NotConfiguredKyc:
    name, is_demo = "none", False

    def create_session(self, **_: object) -> KycSession:
        raise AppError("KYC_UNAVAILABLE", "identity verification is not available yet")

    def fetch_result(self, session_id: str) -> KycResult:
        raise AppError("KYC_UNAVAILABLE", "identity verification is not available yet")

    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> tuple[str, KycResult]:
        raise AppError("KYC_UNAVAILABLE", "identity verification is not available yet")


_cache: dict[str, KycProvider] = {}


def get_kyc_provider(s: Settings) -> KycProvider:
    if s.kyc_provider not in _cache:
        _cache[s.kyc_provider] = SandboxKyc(s.kyc_webhook_secret, s.public_base_url) if s.kyc_provider == "sandbox" else NotConfiguredKyc()
    return _cache[s.kyc_provider]
