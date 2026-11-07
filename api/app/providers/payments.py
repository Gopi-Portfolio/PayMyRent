"""Payment service provider (PSP) adapters.

Two *separate* merchant configurations exist by design:
  • purpose='subscription' — owner pays the platform (platform revenue)
  • purpose='rent'         — tenant pays the owner (owner funds; platform never holds them)

Nothing here claims that owner-specific settlement / sub-merchant onboarding works with a
given PSP. RazorpayAdapter implements only the documented Orders API + webhook HMAC check;
routing rent to an owner's own settlement account (Route / linked accounts, or an
equivalent at Cashfree) is a BLOCKING external verification item — see DECISIONS.md D-03.
"""
from __future__ import annotations

import base64
import json
import secrets
from dataclasses import dataclass
from typing import Protocol

import httpx

from ..core.config import Settings
from ..core.errors import AppError
from ..domain.signatures import hmac_sha256_hex, verify_hmac_sha256_hex


@dataclass(frozen=True)
class Order:
    provider: str
    provider_order_id: str
    amount_paise: int
    checkout: dict          # what the app needs to open the hosted checkout


@dataclass(frozen=True)
class WebhookEvent:
    event_id: str
    kind: str               # 'captured' | 'failed' | 'other'
    provider_order_id: str | None
    provider_payment_id: str | None
    amount_paise: int | None
    raw: dict


@dataclass(frozen=True)
class PaymentStatus:
    status: str             # 'captured' | 'failed' | 'pending'
    provider_payment_id: str | None
    amount_paise: int | None


class PaymentProvider(Protocol):
    name: str
    is_demo: bool

    def create_order(self, *, amount_paise: int, receipt: str, notes: dict, payee_account: str | None) -> Order: ...
    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> WebhookEvent: ...
    def fetch_status(self, provider_order_id: str) -> PaymentStatus: ...


class SandboxProvider:
    """Local/demo adapter. Nothing is charged. The app shows a 'DEMO PAYMENT' banner, and the
    sandbox 'pay' page posts a correctly signed webhook back to us — the same code path as
    production, so activation still happens only via a verified server-side event."""

    name = "sandbox"
    is_demo = True

    def __init__(self, webhook_secret: str, purpose: str, base_url: str) -> None:
        self.secret, self.purpose, self.base_url = webhook_secret, purpose, base_url
        self._orders: dict[str, int] = {}

    def create_order(self, *, amount_paise: int, receipt: str, notes: dict, payee_account: str | None) -> Order:
        oid = "sbx_order_" + secrets.token_hex(8)
        self._orders[oid] = amount_paise
        return Order(self.name, oid, amount_paise, {
            "mode": "sandbox", "demo": True,
            "pay_url": f"{self.base_url}/api/v1/sandbox/pay/{self.purpose}/{oid}?amount={amount_paise}",
        })

    def sign(self, body: bytes) -> str:
        return hmac_sha256_hex(self.secret, body)

    def build_event(self, order_id: str, amount_paise: int, outcome: str) -> bytes:
        return json.dumps({
            "id": "sbx_evt_" + secrets.token_hex(8),
            "event": "payment.captured" if outcome == "success" else "payment.failed",
            "payload": {"payment": {"entity": {"id": "sbx_pay_" + secrets.token_hex(8), "order_id": order_id,
                                               "amount": amount_paise, "currency": "INR"}}},
        }, separators=(",", ":")).encode()

    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> WebhookEvent:
        if not verify_hmac_sha256_hex(self.secret, body, headers.get("x-razorpay-signature")):
            raise AppError("FORBIDDEN", "bad webhook signature")
        return _parse_razorpay_style(body, headers)

    def fetch_status(self, provider_order_id: str) -> PaymentStatus:
        return PaymentStatus("pending", None, self._orders.get(provider_order_id))


class RazorpayAdapter:
    """Orders API + webhook verification. Requires live verification of: account approval,
    UPI intent availability, ₹1 minimum charge/fees, and (for rent) Route/linked-account
    eligibility for every owner before enabling in production."""

    name = "razorpay"
    is_demo = False
    BASE = "https://api.razorpay.com/v1"

    def __init__(self, key_id: str, key_secret: str, webhook_secret: str) -> None:
        if not (key_id and key_secret and webhook_secret):
            raise AppError("PAYMENTS_UNAVAILABLE", "payment provider not configured")
        self.key_id, self.key_secret, self.webhook_secret = key_id, key_secret, webhook_secret

    def _auth(self) -> dict[str, str]:
        tok = base64.b64encode(f"{self.key_id}:{self.key_secret}".encode()).decode()
        return {"Authorization": f"Basic {tok}"}

    def create_order(self, *, amount_paise: int, receipt: str, notes: dict, payee_account: str | None) -> Order:
        body: dict = {"amount": amount_paise, "currency": "INR", "receipt": receipt[:40], "notes": notes}
        if payee_account:
            # Direct-to-owner settlement. Shape must be confirmed against the PSP contract
            # before enabling; we refuse to guess silently.
            raise AppError("PAYMENTS_UNAVAILABLE", "owner settlement routing not yet verified with PSP")
        try:
            r = httpx.post(f"{self.BASE}/orders", json=body, headers=self._auth(), timeout=10)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise AppError("PROVIDER_ERROR", "could not create payment order") from e
        data = r.json()
        return Order(self.name, data["id"], amount_paise, {"mode": "razorpay", "key_id": self.key_id,
                                                           "order_id": data["id"], "amount": amount_paise, "currency": "INR"})

    def verify_webhook(self, body: bytes, headers: dict[str, str]) -> WebhookEvent:
        if not verify_hmac_sha256_hex(self.webhook_secret, body, headers.get("x-razorpay-signature")):
            raise AppError("FORBIDDEN", "bad webhook signature")
        return _parse_razorpay_style(body, headers)

    def fetch_status(self, provider_order_id: str) -> PaymentStatus:
        try:
            r = httpx.get(f"{self.BASE}/orders/{provider_order_id}/payments", headers=self._auth(), timeout=10)
            r.raise_for_status()
        except httpx.HTTPError as e:
            raise AppError("PROVIDER_ERROR", "status check failed") from e
        items = r.json().get("items", [])
        cap = next((p for p in items if p.get("status") == "captured"), None)
        if cap:
            return PaymentStatus("captured", cap["id"], int(cap["amount"]))
        if items and all(p.get("status") == "failed" for p in items):
            return PaymentStatus("failed", None, None)
        return PaymentStatus("pending", None, None)


def _parse_razorpay_style(body: bytes, headers: dict[str, str]) -> WebhookEvent:
    data = json.loads(body)
    ent = (data.get("payload", {}).get("payment") or {}).get("entity") or {}
    event = data.get("event", "")
    kind = "captured" if event in ("payment.captured", "order.paid") else "failed" if event == "payment.failed" else "other"
    event_id = headers.get("x-razorpay-event-id") or data.get("id") or f"{event}:{ent.get('id')}"
    amount = ent.get("amount")
    return WebhookEvent(event_id, kind, ent.get("order_id"), ent.get("id"), int(amount) if amount is not None else None, data)


_cache: dict[str, PaymentProvider] = {}


def get_provider(purpose: str, s: Settings) -> PaymentProvider:
    key = f"{purpose}:{s.subscription_provider if purpose == 'subscription' else s.rent_provider}"
    if key in _cache:
        return _cache[key]
    if purpose == "subscription":
        p: PaymentProvider = (SandboxProvider(s.subscription_webhook_secret, purpose, s.public_base_url)
                              if s.subscription_provider == "sandbox"
                              else RazorpayAdapter(s.subscription_key_id, s.subscription_key_secret, s.subscription_webhook_secret))
    elif purpose == "rent":
        p = (SandboxProvider(s.rent_webhook_secret, purpose, s.public_base_url) if s.rent_provider == "sandbox"
             else RazorpayAdapter(s.rent_key_id, s.rent_key_secret, s.rent_webhook_secret))
    else:
        raise ValueError(purpose)
    _cache[key] = p
    return p
