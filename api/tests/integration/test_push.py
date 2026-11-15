"""Phone push (Firebase Cloud Messaging): token registration, who can see a token, delivery and dead-token clean-up. Requires PostgreSQL."""
from __future__ import annotations

import json
import uuid

from app.core.db import transaction
from app.modules import notify
from app.providers.messaging import FcmSender

from .conftest import pay_subscription
from .test_rls import as_app

TOK = lambda: "fcm-test-token-" + uuid.uuid4().hex + uuid.uuid4().hex       # noqa: E731  (a plausible 60+ character token)


def _quiet_off(sql, user):
    sql("UPDATE notification_preferences SET quiet_start = '00:00', quiet_end = '00:00', push_enabled = true WHERE user_id = %s", user.id)


def _push(user_id, template="payment_received", **p):
    with transaction() as db:
        notify.enqueue(db, user_id, template, {"amount": "Rs 1", "unit": "S-1", "receipt": "R1", **p}, f"push-test:{uuid.uuid4().hex}", channels=("push",))
    with transaction() as db:
        notify.dispatch_pending(db, limit=5000)


def _last(sql, user, dedupe="push-test:%"):
    return sql("SELECT status, destination_masked, skip_reason, provider FROM notification_events WHERE user_id = %s AND dedupe_key LIKE %s ORDER BY created_at DESC LIMIT 1", user.id, dedupe)[0]


def test_token_registration_belongs_to_the_signed_in_person(actor, sql):
    a, b = actor(), actor()
    t = TOK()
    assert a.post("/api/v1/me/push-token", json={"token": t, "platform": "android"}).status_code == 200
    assert a.post("/api/v1/me/push-token", json={"token": t, "platform": "android"}).status_code == 200      # registering again is harmless
    assert sql("SELECT count(*), min(user_id::text) FROM push_tokens WHERE token = %s", t)[0] == (1, str(a.id))
    assert a.post("/api/v1/me/push-token", json={"token": "short", "platform": "android"}).status_code in (400, 422)
    assert a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "windows"}).status_code in (400, 422)
    # someone else cannot remove it
    assert b.post("/api/v1/me/push-token/remove", json={"token": t}).status_code == 200
    assert sql("SELECT count(*) FROM push_tokens WHERE token = %s", t)[0][0] == 1
    # the next person to sign in on the same phone takes the token; the first person no longer receives anything on it
    assert b.post("/api/v1/me/push-token", json={"token": t, "platform": "android"}).status_code == 200
    assert sql("SELECT user_id::text FROM push_tokens WHERE token = %s", t)[0][0] == str(b.id)
    assert b.post("/api/v1/me/push-token/remove", json={"token": t}).status_code == 200
    assert sql("SELECT count(*) FROM push_tokens WHERE token = %s", t)[0][0] == 0


def test_a_person_keeps_at_most_ten_devices(actor, sql):
    a = actor()
    for _ in range(12):
        assert a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "ios"}).status_code == 200
    assert sql("SELECT count(*) FROM push_tokens WHERE user_id = %s", a.id)[0][0] == 10


def test_tokens_are_invisible_to_other_people_in_the_database(actor, sql):
    a, b = actor(), actor()
    a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "android"})
    with as_app({"app.user_id": str(a.id)}) as c:
        assert c.execute("SELECT count(*) FROM push_tokens").fetchone()[0] == 1
    with as_app({"app.user_id": str(b.id)}) as c:
        assert c.execute("SELECT count(*) FROM push_tokens").fetchone()[0] == 0
        assert c.execute("DELETE FROM push_tokens").rowcount == 0                 # not even a query with no WHERE reaches another person's tokens
    with as_app() as c:
        assert c.execute("SELECT count(*) FROM push_tokens").fetchone()[0] == 0


def test_push_goes_to_registered_devices_only_and_follows_the_user_setting(actor, sql):
    a = actor()
    _quiet_off(sql, a)
    _push(a.id)                                                                    # no phone registered yet
    assert _last(sql, a)[:3] == ("skipped", None, "no_device")
    a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "android"})
    a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "ios"})
    _push(a.id)
    st, dest, _, prov = _last(sql, a)
    assert (st, dest, prov) == ("sent", "2 device(s)", "console-push")             # the console sender stands in until Firebase is configured
    sql("UPDATE notification_preferences SET push_enabled = false WHERE user_id = %s", a.id)
    _push(a.id)
    assert _last(sql, a)[:3] == ("skipped", None, "channel_disabled")


def test_the_push_text_carries_no_payee_or_reference_details(actor, sql):
    a = actor()
    _quiet_off(sql, a)
    a.post("/api/v1/me/push-token", json={"token": TOK(), "platform": "android"})
    _push(a.id, "transfer_reported", tenant="Ravi")
    row = sql("SELECT payload::text FROM notification_events WHERE user_id = %s AND template = 'transfer_reported'", a.id)[0][0]
    assert "@ok" not in row and "UTR" not in row


class _Resp:
    def __init__(self, code, text="{}"):
        self.status_code, self.text = code, text

    def json(self):
        return json.loads(self.text)


def test_fcm_sender_builds_the_message_and_reports_dead_tokens(monkeypatch):
    import httpx
    sent = []
    good, gone = TOK(), TOK()

    def fake_post(url, json=None, headers=None, timeout=None):                     # noqa: A002
        sent.append((url, json, headers))
        if json["message"]["token"] == gone:
            return _Resp(404, '{"error": {"status": "NOT_FOUND", "details": [{"errorCode": "UNREGISTERED"}]}}')
        return _Resp(200, '{"name": "projects/demo/messages/abc"}')

    monkeypatch.setattr(httpx, "post", fake_post)
    s = FcmSender(json.dumps({"project_id": "demo-project", "client_email": "x@demo.iam.gserviceaccount.com", "private_key": "unused"}))
    monkeypatch.setattr(s, "_token", lambda: "access-token")
    r = s.send(to=f"{good},{gone}", template="payment_received", language="en", params={}, body="Payment of Rs 1 is confirmed.")
    assert r.status == "sent" and r.provider == "fcm" and r.dead_tokens == (gone,)
    assert sent[0][0] == "https://fcm.googleapis.com/v1/projects/demo-project/messages:send" and sent[0][2]["Authorization"] == "Bearer access-token"
    m = sent[0][1]["message"]
    assert m["notification"] == {"title": "RentMeezy", "body": "Payment of Rs 1 is confirmed."} and m["data"] == {"template": "payment_received"}
    only_dead = s.send(to=gone, template="payment_received", language="en", params={}, body="x")
    assert only_dead.status == "failed" and only_dead.dead_tokens == (gone,)


def test_dead_tokens_are_switched_off_after_delivery(actor, sql, monkeypatch):
    from app.providers import messaging
    a = actor()
    _quiet_off(sql, a)
    dead = TOK()
    a.post("/api/v1/me/push-token", json={"token": dead, "platform": "android"})

    class Gone:
        def send(self, **_):
            return messaging.SendResult("failed", "fcm", None, "no_valid_device", (dead,))

    monkeypatch.setattr(notify, "get_sender", lambda channel, s: Gone())
    _push(a.id)
    assert sql("SELECT disabled_at IS NOT NULL FROM push_tokens WHERE token = %s", dead)[0][0] is True
    _push(a.id)
    assert _last(sql, a)[2] == "no_device"                                         # nothing more is sent to it
    a.post("/api/v1/me/push-token", json={"token": dead, "platform": "android"})   # the app is reinstalled: it registers again and is switched back on
    assert sql("SELECT disabled_at IS NULL FROM push_tokens WHERE token = %s", dead)[0][0] is True
