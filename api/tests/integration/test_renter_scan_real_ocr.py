"""The REAL text reader (Tesseract) on drawn pictures of a rent agreement and a visiting card: the whole path from a photo to a suggested name and number.
Skipped where Tesseract is not installed (it is in the API image)."""
from __future__ import annotations

import io
import shutil

import pytest

pytestmark = pytest.mark.skipif(shutil.which("tesseract") is None, reason="Tesseract is not installed")


def drawn(lines: list[str], size: int = 46, width: int = 1400) -> bytes:
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:                                                    # an older Pillow
        font = ImageFont.load_default()
    height = 60 + len(lines) * (size + 26)
    img = Image.new("RGB", (width, max(height, 500)), "white")
    d = ImageDraw.Draw(img)
    y = 30
    for ln in lines:
        d.text((40, y), ln, fill="black", font=font)
        y += size + 26
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=92)
    return buf.getvalue()


def scan(owner, data: bytes):
    return owner.c.post("/api/v1/owner/renter-scan", headers=owner.h(), files={"file": ("card.jpg", data, "image/jpeg")})


def test_a_drawn_tenant_form_is_read_for_real(actor):
    owner = actor(roles=("owner",))
    r = scan(owner, drawn(["TENANT DETAILS", "Name : Imran Khan", "Mobile No : 9123456780", "Address : 5 Lake View Road"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mobile"] == "9123456780", body
    assert body["name"] == "IMRAN KHAN", body
    assert body["found"] is True


def test_a_drawn_agreement_gives_the_tenant_not_the_landlord(actor):
    owner = actor(roles=("owner",))
    r = scan(owner, drawn(["RENTAL AGREEMENT", "between Mr. Anand Raj (hereinafter called the Lessor)", "and Mrs. Kavya Iyer, mobile 98765 43210", "(hereinafter called the Tenant)"]))
    assert r.status_code == 200, r.text
    body = r.json()
    import difflib
    like = lambda x, y: difflib.SequenceMatcher(None, x, y).ratio()                                  # letter by letter: one misread letter still scores high
    assert body["name"] and like(body["name"], "KAVYA IYER") >= 0.85, body                           # the tenant, not the landlord; one misread letter is normal for OCR,
    assert like(body["name"], "ANAND RAJ") < 0.6, body                                               # which is why the owner always checks what was read
    assert body["mobile"] == "9876543210", body


def test_a_blank_picture_finds_nothing(actor):
    owner = actor(roles=("owner",))
    r = scan(owner, drawn([""]))
    assert r.status_code == 200
    assert r.json() == {"name": None, "mobile": None, "found": False}
