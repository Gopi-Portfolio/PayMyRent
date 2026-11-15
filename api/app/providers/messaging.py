"""Outbound messaging adapters. 'console' adapters log a redacted line and report status
'sent' with a fake id so local flows can be exercised; they never claim delivery.

Production notes (blocking, external):
  • SMS: India DLT — registered entity, header and every template must be approved by
    the chosen provider before sending. Template ids go in app/i18n/templates.json.
  • WhatsApp: Business Platform via an approved BSP; only pre-approved templates outside
    the 24-hour window; explicit opt-in recorded in consent_records.
  • Email: Amazon SES out of sandbox in ap-south-1 with verified domain (SPF/DKIM/DMARC).
  • Push: FCM HTTP v1 with a service account kept in AWS Secrets Manager / SSM (RG_FCM_SERVICE_ACCOUNT_JSON).
"""
from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from typing import Protocol

from ..core.config import Settings
from ..domain.signatures import mask_email, mask_phone

log = logging.getLogger("paymyrent.messaging")


@dataclass(frozen=True)
class SendResult:
    status: str                 # 'sent' | 'failed'
    provider: str
    provider_message_id: str | None
    error: str | None = None
    dead_tokens: tuple[str, ...] = ()      # push: tokens FCM says are no longer valid (the app was removed): the caller stops using them


class Sender(Protocol):
    def send(self, *, to: str, template: str, language: str, params: dict, body: str, subject: str | None = None) -> SendResult: ...


class ConsoleSender:
    def __init__(self, channel: str) -> None:
        self.channel = channel

    def send(self, *, to: str, template: str, language: str, params: dict, body: str, subject: str | None = None) -> SendResult:
        masked = mask_email(to) if "@" in to else mask_phone(to) if to.startswith("+") else to
        log.info("[DEMO %s] to=%s template=%s lang=%s", self.channel.upper(), masked, template, language)
        return SendResult("sent", f"console-{self.channel}", "demo-" + secrets.token_hex(6))


class SesEmailSender:
    def __init__(self, region: str, from_address: str) -> None:
        import boto3  # imported lazily so local dev doesn't need AWS libs
        self.client = boto3.client("sesv2", region_name=region)
        self.from_address = from_address

    def send(self, *, to: str, template: str, language: str, params: dict, body: str, subject: str | None = None) -> SendResult:
        try:
            r = self.client.send_email(FromEmailAddress=self.from_address, Destination={"ToAddresses": [to]},
                                       Content={"Simple": {"Subject": {"Data": subject or "RentMeezy", "Charset": "UTF-8"},
                                                           "Body": {"Text": {"Data": body, "Charset": "UTF-8"}}}})
            return SendResult("sent", "ses", r.get("MessageId"))
        except Exception as e:  # noqa: BLE001
            return SendResult("failed", "ses", None, type(e).__name__)


class FcmSender:
    """Firebase Cloud Messaging HTTP v1. `to` is one or more device tokens separated by commas.
    The message carries a short text and the template name only; the app opens the right screen from the template.
    Never payee IDs, references or bank details."""
    SCOPE = "https://www.googleapis.com/auth/firebase.messaging"

    def __init__(self, service_account_json: str) -> None:
        import json
        self.info = json.loads(service_account_json)
        self.project = self.info["project_id"]
        self._cred = None

    def _token(self) -> str:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
        if self._cred is None:
            self._cred = service_account.Credentials.from_service_account_info(self.info, scopes=[self.SCOPE])
        if not self._cred.valid:
            self._cred.refresh(Request())
        return self._cred.token

    def send(self, *, to: str, template: str, language: str, params: dict, body: str, subject: str | None = None) -> SendResult:
        import httpx
        try:
            auth = {"Authorization": f"Bearer {self._token()}"}
        except Exception as e:  # noqa: BLE001
            return SendResult("failed", "fcm", None, "auth_" + type(e).__name__)
        ok, dead, last_id, err = 0, [], None, None
        for tok in [t for t in to.split(",") if t]:
            msg = {"message": {"token": tok, "notification": {"title": subject or "RentMeezy", "body": body[:240]},
                               "data": {"template": template}, "android": {"priority": "HIGH"}}}
            try:
                r = httpx.post(f"https://fcm.googleapis.com/v1/projects/{self.project}/messages:send", json=msg, headers=auth, timeout=10)
            except httpx.HTTPError as e:
                err = type(e).__name__
                continue
            if r.status_code == 200:
                ok += 1
                last_id = r.json().get("name")
            elif r.status_code in (400, 404) and ("UNREGISTERED" in r.text or "INVALID_ARGUMENT" in r.text and "token" in r.text.lower()):
                dead.append(tok)
            else:
                err = f"http_{r.status_code}"
        if ok:
            return SendResult("sent", "fcm", last_id, None, tuple(dead))
        return SendResult("failed", "fcm", None, err or ("no_valid_device" if dead else "no_device"), tuple(dead))


class NotConfiguredSender:
    def __init__(self, name: str) -> None:
        self.name = name

    def send(self, **_: object) -> SendResult:
        return SendResult("failed", self.name, None, "provider_not_configured")


def get_sender(channel: str, s: Settings) -> Sender:
    choice = {"sms": s.sms_provider, "whatsapp": s.whatsapp_provider, "email": s.email_provider, "push": s.push_provider}[channel]
    if choice == "console":
        return ConsoleSender(channel)
    if channel == "email" and choice == "ses":
        return SesEmailSender(s.aws_region, s.ses_from_address)
    if channel == "push" and choice == "fcm" and s.fcm_service_account_json:
        return FcmSender(s.fcm_service_account_json)
    # SMS (DLT provider), WhatsApp BSP and FCM adapters are added once accounts exist;
    # until then messages are recorded as failed with a clear reason instead of pretending.
    return NotConfiguredSender(choice)
