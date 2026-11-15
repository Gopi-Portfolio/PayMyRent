"""RG_ACTION_CODES_REQUIRED: false = the login code is the only code ever asked; true (the default) = the extra one-time code before sensitive steps."""
from __future__ import annotations


def start_identity(owner):
    notice = owner.get("/api/v1/me/identity").json()["notice_version"]
    return owner.post("/api/v1/me/identity/start", json={"consent": True, "notice_version": notice})


def test_by_default_a_sensitive_step_still_needs_its_code(actor):
    o = actor(roles=("owner",), identity=False)
    o.auto_otp = False                                        # the test Actor must not fetch the code for us
    assert o.get("/api/v1/me").json()["action_codes_required"] is True
    r = start_identity(o)
    assert r.status_code == 403 and r.json()["error"]["details"]["otp_required"] is True


def test_with_the_extra_codes_off_no_code_is_asked_and_the_app_is_told(actor, monkeypatch):
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), "action_codes_required", False)
    o = actor(roles=("owner",), identity=False)
    o.auto_otp = False
    assert o.get("/api/v1/me").json()["action_codes_required"] is False      # the app hides every extra code box
    r = start_identity(o)
    assert r.status_code == 200, r.text                                      # no code was sent, none was needed
