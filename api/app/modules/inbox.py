"""The notification bell: what the app and the messages told this person lately, in their language, with an unread count.
Read from the same notification records the SMS/push messages use, so the bell and the message always say the same thing.
It works even when SMS is switched off, over the plan allowance or held for quiet hours.

One person can be both an owner and a renter. The bell follows the role they are using: an owner sees owner news (a renter asked for
relief, subscription ending), a renter sees renter news (rent changed, cash recorded). Security notices and disputes show in both."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Query

from ..core.auth import CurrentUser, complete_user
from ..core.db import Db, get_db
from ..i18n.templates import render

router = APIRouter(prefix="/api/v1", tags=["notifications"])

HIDDEN = ("otp",)          # a one-time code is never listed
OWNER_NEWS = ("relief_requested", "vacate_requested", "subscription_expiring", "message_sent", "agreement_ending_owner", "agreement_lapsed_owner")
RENTER_NEWS = ("terms_changed", "cash_recorded", "payment_received", "deposit_changed", "relief_approved", "relief_declined", "vacate_declined",
               "charge_reviewed", "tenancy_closed", "owner_transferred", "invitation", "rent_reminder", "agreement_renewed", "agreement_ending_tenant", "agreement_lapsed_tenant", "owner_message")
SEEN_COLUMN = {"owner": "notifications_seen_owner_at", "tenant": "notifications_seen_at"}


def _templates_for(role: str) -> list[str]:
    """The other role's news, to leave out. Anything not classified shows in both roles until it is."""
    return list(RENTER_NEWS if role == "owner" else OWNER_NEWS)


@router.get("/me/notifications")
def my_notifications(role: Literal["owner", "tenant"] = Query("tenant"), user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    seen = db.scalar(f"SELECT {SEEN_COLUMN[role]} FROM users WHERE id = :u", u=user.id)
    # "a renter asked for relief" is a to-do: once the request is answered or taken back it leaves the bell (the dedupe key is relief-req:<request id>:<user>)
    rows = db.all("""SELECT n.id, n.template, n.payload, n.created_at FROM notification_events n
                     WHERE n.user_id = :u AND n.channel = 'push' AND n.template <> ALL(:hidden) AND n.template <> ALL(:other)
                       AND n.created_at > now() - interval '30 days'
                       AND (n.template <> 'relief_requested' OR EXISTS (SELECT 1 FROM rent_relief r WHERE r.id::text = split_part(n.dedupe_key, ':', 2) AND r.status = 'requested'))
                       AND (n.template <> 'vacate_requested' OR EXISTS (SELECT 1 FROM vacate_requests v WHERE v.id::text = split_part(n.dedupe_key, ':', 2) AND v.status = 'requested'))
                     ORDER BY n.created_at DESC LIMIT 50""", u=user.id, hidden=list(HIDDEN), other=_templates_for(role))
    items, unread = [], 0
    for r in rows:
        p = r["payload"] or {}
        try:
            text = p["body"] if "body" in p else render(r["template"], user.language, **p)
        except (KeyError, IndexError):
            continue
        is_new = seen is None or r["created_at"] > seen
        unread += is_new
        items.append({"id": str(r["id"]), "template": r["template"], "text": text, "created_at": r["created_at"], "unread": is_new,
                      **({"tenancy_id": p["tenancy_id"]} if "tenancy_id" in p else {})})
    # agreement renewal reminders: worked out now, so they stay in the list until the end date has been moved out. They count as new again each day.
    from .agreements import renewal_alerts
    day_start = db.scalar("SELECT date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'")
    pinned = []
    for a in renewal_alerts(db, user.id, role):
        template = f"agreement_{'lapsed' if a['days_left'] < 0 else 'ending'}_{'owner' if role == 'owner' else 'tenant'}"
        text = render(template, user.language, unit=a["identifier"], date=f"{a['end_date']:%d-%m-%Y}", days=a["days_left"], tenant=a["renter"] or "")
        is_new = seen is None or day_start > seen
        unread += is_new
        pinned.append({"id": f"agreement:{a['id']}", "template": template, "text": text, "created_at": day_start, "unread": is_new,
                       "tenancy_id": str(a["id"]), "days_left": a["days_left"], "pinned": True})
    return {"items": pinned + items, "unread": unread, "role": role}


@router.post("/me/notifications/seen")
def mark_seen(role: Literal["owner", "tenant"] = Query("tenant"), user: CurrentUser = Depends(complete_user), db: Db = Depends(get_db)) -> dict:
    db.exec(f"UPDATE users SET {SEEN_COLUMN[role]} = now() WHERE id = :u", u=user.id)
    return {"unread": 0}
