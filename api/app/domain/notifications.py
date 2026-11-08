"""Pure rules for who gets which message, where, and when."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time
from uuid import UUID


@dataclass(frozen=True)
class Contact:
    id: UUID
    kind: str          # 'mobile' | 'email'
    value: str
    verified: bool


@dataclass(frozen=True)
class Preferences:
    sms_contact_id: UUID | None
    whatsapp_contact_id: UUID | None
    email_contact_id: UUID | None
    sms_enabled: bool
    whatsapp_enabled: bool
    email_enabled: bool
    push_enabled: bool
    quiet_start: time
    quiet_end: time


def resolve_destination(channel: str, prefs: Preferences, contacts: list[Contact],
                        consents: dict[str, bool], has_push_token: bool) -> tuple[str | None, str | None]:
    """Return (destination, None) or (None, skip_reason). Never falls back to an unverified contact."""
    by_id = {c.id: c for c in contacts}
    if channel == "push":
        if not prefs.push_enabled:
            return None, "channel_disabled"
        return ("device", None) if has_push_token else (None, "no_device")
    if channel in ("sms", "whatsapp"):
        enabled = prefs.sms_enabled if channel == "sms" else prefs.whatsapp_enabled
        if not enabled:
            return None, "channel_disabled"
        if not consents.get(channel, channel == "sms"):
            # SMS transactional alerts default to allowed under the user's onboarding consent;
            # WhatsApp always needs an explicit opt-in record.
            return None, "no_consent"
        cid = prefs.sms_contact_id if channel == "sms" else prefs.whatsapp_contact_id
        c = by_id.get(cid) if cid else None
        if c is None or c.kind != "mobile" or not c.verified:
            return None, "no_verified_destination"
        return c.value, None
    if channel == "email":
        if not prefs.email_enabled:
            return None, "channel_disabled"
        c = by_id.get(prefs.email_contact_id) if prefs.email_contact_id else None
        if c is None or c.kind != "email" or not c.verified:
            return None, "no_verified_destination"
        return c.value, None
    return None, "unknown_channel"


def in_quiet_hours(now_local: datetime, start: time, end: time) -> bool:
    t = now_local.time()
    if start == end:
        return False
    return (start <= t or t < end) if start > end else (start <= t < end)


def reminder_offset_due(today: date, due_date: date, offsets_days: list[int], open_paise: int,
                        tenancy_active: bool) -> int | None:
    """Which configured offset (days relative to due date; negative = before) fires today, if any.

    No reminder for fully paid invoices or closed tenancies. Partial balances keep reminding.
    """
    if open_paise <= 0 or not tenancy_active:
        return None
    delta = (today - due_date).days
    return delta if delta in offsets_days else None


def reminder_dedupe_key(invoice_id: UUID, offset: int, channel: str) -> str:
    return f"reminder:{invoice_id}:{offset}:{channel}"


OWNER_DUE_SOON_DAYS = 5      # the owner is told this many days before the due date
OWNER_OVERDUE_EVERY = 7      # and, once it is late, on the first day after and then weekly


def overdue_days(today: date, due_date: date, open_paise: int, tenancy_active: bool) -> int | None:
    """Days past the due date while money is still owed (the renter is reminded every one of these days); None otherwise."""
    if open_paise <= 0 or not tenancy_active:
        return None
    d = (today - due_date).days
    return d if d >= 1 else None


def owner_notice(today: date, due_date: date, open_paise: int, tenancy_active: bool) -> tuple[str, int] | None:
    """('soon', days_left) 5 days before the due date; ('late', days_late) the day after and then weekly. None on other days."""
    if open_paise <= 0 or not tenancy_active:
        return None
    delta = (today - due_date).days
    if delta == -OWNER_DUE_SOON_DAYS:
        return "soon", -delta
    if delta >= 1 and (delta - 1) % OWNER_OVERDUE_EVERY == 0:
        return "late", delta
    return None
