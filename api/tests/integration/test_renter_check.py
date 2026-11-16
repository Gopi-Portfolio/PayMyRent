"""The owner's quick check on a renter's mobile number: only 'is the photo ID verified', never anything else about the person. Requires PostgreSQL."""
from __future__ import annotations

from .conftest import new_phone


def test_a_verified_renter_shows_as_id_verified(actor):
    owner = actor(roles=("owner",))
    renter = actor(roles=("tenant",))
    renter.verify_identity()
    r = owner.get("/api/v1/owner/renter-check", params={"mobile": renter.phone})
    assert r.status_code == 200, r.text
    assert r.json() == {"id_verified": True}                       # a yes or no and nothing more: no name, no id


def test_an_unverified_or_unknown_number_is_simply_not_verified(actor):
    owner = actor(roles=("owner",))
    not_verified = actor(roles=("tenant",))
    assert owner.get("/api/v1/owner/renter-check", params={"mobile": not_verified.phone}).json() == {"id_verified": False}
    assert owner.get("/api/v1/owner/renter-check", params={"mobile": new_phone()}).json() == {"id_verified": False}     # no account at all looks the same


def test_a_bad_number_is_refused_and_a_renter_cannot_use_the_check(actor):
    owner = actor(roles=("owner",))
    assert owner.get("/api/v1/owner/renter-check", params={"mobile": "12345"}).status_code in (400, 422)
    renter = actor(roles=("tenant",))
    assert renter.get("/api/v1/owner/renter-check", params={"mobile": new_phone()}).status_code in (401, 403)


def test_checks_are_limited_so_numbers_cannot_be_scanned(actor):
    owner = actor(roles=("owner",))
    codes = [owner.get("/api/v1/owner/renter-check", params={"mobile": new_phone()}).status_code for _ in range(32)]
    assert codes[:30] == [200] * 30 and codes[-1] == 429
