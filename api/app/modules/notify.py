"""Notification outbox. Business code only *enqueues* (inside its own transaction, so a
rolled-back payment never sends a message); the dispatcher job resolves destinations,
honours consent/quiet hours, sends once (dedupe_key is UNIQUE) and records status."""
from __future__ import annotations

import json
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from ..core.config import get_settings
from ..core.db import Db
from ..domain.notifications import Contact, Preferences, in_quiet_hours, resolve_destination
from ..domain.signatures import mask_email, mask_phone
from ..i18n.templates import render
from ..providers.messaging import get_sender

IST = ZoneInfo("Asia/Kolkata")
URGENT = {"otp", "security_event"}           # bypass quiet hours


def enqueue(db: Db, user_id: UUID, template: str, params: dict, dedupe_key: str, owner: UUID | None = None,
            channels: tuple[str, ...] = ("push", "sms"), approved_by: UUID | None = None) -> None:
    lang = db.scalar("SELECT preferred_language FROM users WHERE id = :u", u=user_id) or "en"
    for ch in channels:
        db.exec("""INSERT INTO notification_events(user_id, owner_account_id, channel, template, language, dedupe_key, payload, approved_by)
                   VALUES (:u, :o, :c, :t, :l, :k, CAST(:p AS jsonb), :a) ON CONFLICT (dedupe_key) DO NOTHING""",
                u=user_id, o=owner, c=ch, t=template, l=lang, k=f"{dedupe_key}:{ch}",
                p=json.dumps(params, default=str, ensure_ascii=False), a=approved_by)


def send_otp(db: Db, kind: str, target: str, code: str, language: str) -> None:
    """OTP to a not-yet-verified secondary contact goes out immediately (not via preferences)."""
    channel = "sms" if kind == "mobile" else "email"
    body = render("otp", language, code=code)
    get_sender(channel, get_settings()).send(to=target, template="otp", language=language, params={"code": "***"},
                                             body=body, subject="PayMyRent verification code")


def security_event(db: Db, user_id: UUID, extra_phone: str | None, event: str) -> None:
    enqueue(db, user_id, "security_event", {"event": event}, f"sec:{user_id}:{event}:{datetime.now().timestamp():.0f}",
            channels=("push", "sms", "email"))
    if extra_phone:  # also tell the old number, which is no longer a contact
        get_sender("sms", get_settings()).send(to=extra_phone, template="security_event", language="en",
                                               params={"event": event}, body=render("security_event", "en", event=event))


def message_usage(db: Db, owner: UUID) -> dict:
    """This month's paid-message use against the plan allowance (IST calendar month)."""
    lim = db.one("""SELECT l.paid_units, l.email_messages FROM owner_subscriptions s JOIN plan_message_limits l ON l.plan_id = s.plan_id
                    WHERE s.owner_account_id = :o AND s.status = 'active'""", o=owner)
    used = db.one("""SELECT COALESCE(sum(CASE channel WHEN 'sms' THEN 1 WHEN 'whatsapp' THEN 2 ELSE 0 END), 0) AS units,
                            count(*) FILTER (WHERE channel = 'email') AS emails
                     FROM notification_events
                     WHERE owner_account_id = :o AND status = 'sent'
                       AND sent_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'""", o=owner)
    return {"paid_units_used": int(used["units"]), "paid_units_limit": lim["paid_units"] if lim else 0,
            "emails_used": int(used["emails"]), "emails_limit": lim["email_messages"] if lim else 0}


def _over_cap(db: Db, ev) -> str | None:  # noqa: ANN001
    if ev["owner_account_id"] is None or ev["template"] in URGENT or ev["channel"] not in ("sms", "whatsapp", "email"):
        return None
    u = message_usage(db, ev["owner_account_id"])
    if ev["channel"] == "email":
        return "plan_email_cap" if u["emails_used"] >= u["emails_limit"] else None
    need = 2 if ev["channel"] == "whatsapp" else 1
    return "plan_message_cap" if u["paid_units_used"] + need > u["paid_units_limit"] else None


def dispatch_pending(db: Db, limit: int = 200) -> dict:
    s = get_settings()
    now_local = datetime.now(IST)
    sent = skipped = failed = deferred = 0
    rows = db.all("""SELECT * FROM notification_events WHERE status = 'queued' AND attempts < 5
                     ORDER BY created_at LIMIT :n FOR UPDATE SKIP LOCKED""", n=limit)
    for ev in rows:
        p = db.one("SELECT * FROM notification_preferences WHERE user_id = :u", u=ev["user_id"])
        if p is None:
            db.exec("UPDATE notification_events SET status='skipped', skip_reason='no_preferences' WHERE id=:i", i=ev["id"])
            skipped += 1
            continue
        prefs = Preferences(p["sms_contact_id"], p["whatsapp_contact_id"], p["email_contact_id"], p["sms_enabled"],
                            p["whatsapp_enabled"], p["email_enabled"], p["push_enabled"], p["quiet_start"], p["quiet_end"])
        if ev["template"] not in URGENT and in_quiet_hours(now_local, prefs.quiet_start, prefs.quiet_end):
            deferred += 1
            continue
        capped = _over_cap(db, ev)
        if capped:      # push still reaches the person for free; only the paid channel is held back
            db.exec("UPDATE notification_events SET status='skipped', skip_reason=:r WHERE id=:i", r=capped, i=ev["id"])
            skipped += 1
            continue
        contacts = [Contact(c["id"], c["kind"], c["value"], c["verified"]) for c in db.all(
            """SELECT id, kind, value, verified_at IS NOT NULL AS verified FROM user_contacts
               WHERE user_id = :u AND removed_at IS NULL""", u=ev["user_id"])]
        consents = {r["channel"]: r["granted"] for r in db.all(
            """SELECT DISTINCT ON (channel) channel, granted FROM consent_records WHERE user_id = :u
               ORDER BY channel, created_at DESC""", u=ev["user_id"])}
        dest, reason = resolve_destination(ev["channel"], prefs, contacts, consents, has_push_token=False)
        if dest is None:
            db.exec("UPDATE notification_events SET status='skipped', skip_reason=:r WHERE id=:i", r=reason, i=ev["id"])
            skipped += 1
            continue
        params = ev["payload"]
        body = render(ev["template"], ev["language"], **params) if "body" not in params else params["body"]
        res = get_sender(ev["channel"], s).send(to=dest, template=ev["template"], language=ev["language"], params=params, body=body)
        masked = mask_email(dest) if "@" in dest else mask_phone(dest)
        db.exec("""UPDATE notification_events SET status = :st, provider = :pv, provider_message_id = :m, destination_masked = :d,
                   attempts = attempts + 1, sent_at = CASE WHEN :st = 'sent' THEN now() END, skip_reason = :e WHERE id = :i""",
                st="sent" if res.status == "sent" else ("failed" if ev["attempts"] >= 4 else "queued"), pv=res.provider,
                m=res.provider_message_id, d=masked, e=res.error, i=ev["id"])
        sent += res.status == "sent"
        failed += res.status != "sent"
    return {"sent": sent, "skipped": skipped, "failed": failed, "deferred": deferred}
