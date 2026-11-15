"""The REAL open-source engines (Tesseract and OpenCV), not the fakes used by the integration tests.
Skipped where Tesseract or the models are not installed (they are in the Docker image the API runs from)."""
from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest

from app.domain import docmatch

# (Never call get_settings() at import time here: it is cached, and the integration tests set their environment after collection.)
@pytest.fixture(autouse=True)
def _fresh_settings():
    """The engine reads the (cached) settings; never leave them cached for integration tests that set their own environment later."""
    yield
    from app.core.config import get_settings
    get_settings.cache_clear()


needs_tesseract = pytest.mark.skipif(shutil.which("tesseract") is None, reason="tesseract is not installed")
needs_models = pytest.mark.skipif(not Path("/srv/models/face_recognition_sface_2021dec.onnx").exists(), reason="face models are not installed")


def card(lines: list[str], *, rotate: float = 0, noise: bool = False) -> bytes:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (1000, 760), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=40)
    for i, t in enumerate(lines):
        d.text((60, 40 + i * 64), t, fill="black", font=font)
    if rotate:
        img = img.rotate(rotate, expand=False, fillcolor=(235, 235, 235))
    if noise:                       # a phone photo is never perfectly clean
        arr = np.array(img).astype("int16") + np.random.default_rng(1).normal(0, 10, (760, 1000, 3)).astype("int16")
        img = Image.fromarray(arr.clip(0, 255).astype("uint8"))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=60)
    return buf.getvalue()


PAN_LINES = ["INCOME TAX DEPARTMENT", "GOVT. OF INDIA", "Permanent Account Number", "ABCPE1234F", "Name", "RAMESH KUMAR SHARMA",
             "Father's Name", "SURESH SHARMA", "Date of Birth", "12/05/1980"]


@needs_tesseract
@pytest.mark.parametrize("kw", [{}, {"rotate": 3, "noise": True}])
def test_tesseract_reads_the_pan_the_name_and_the_birth_date(kw):
    from app.providers.docs import LocalEngine
    text = LocalEngine().read_text(card(PAN_LINES, **kw))
    assert docmatch.find_pan(text) == "ABCPE1234F"
    assert docmatch.name_in_text("Ramesh Kumar Sharma", docmatch.pan_name_region(text))
    assert not docmatch.name_in_text("Meena Devi", docmatch.pan_name_region(text))
    assert str(docmatch.find_birth_date(text)) == "1980-05-12"


@needs_tesseract
def test_a_blank_photo_reads_as_nothing():
    from app.providers.docs import LocalEngine
    assert not docmatch.enough_text(LocalEngine().read_text(card([])))


@needs_models
def test_the_face_models_load_and_a_photo_without_a_face_is_reported():
    from app.providers.docs import LocalEngine
    score, problem = LocalEngine().face_score(card(["no face here"]), card(["nor here"]))
    assert score is None and problem == "selfie"


@needs_tesseract
def test_the_real_engine_hides_the_first_eight_digits_of_an_aadhaar_number_in_the_photo():
    from app.providers.docs import LocalEngine
    base = "23456789012"
    number = base + docmatch.verhoeff_check_digit(base)
    lines = ["Government of India", "RAMESH KUMAR SHARMA", "DOB: 12/05/1980", "Male", f"{number[:4]} {number[4:8]} {number[8:]}", "VID: 9876 5432 1098 7654"]
    original = card(lines)
    eng = LocalEngine()
    text, masked = eng.read_aadhaar(original)
    assert docmatch.find_aadhaar(text) == number                      # the real engine reads the number...
    assert masked is not None and masked != original                  # ...and returns a photo with the digits covered
    again = eng.read_text(masked)
    assert docmatch.find_aadhaar(again) is None                       # the full number can no longer be read from the stored photo
    assert number[:8] not in again.replace(" ", "")
    assert "98765432" not in again.replace(" ", "")                   # a printed VID is covered as well
    assert "RAMESH" in again                                          # the rest of the card is untouched
