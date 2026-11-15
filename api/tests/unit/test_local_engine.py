"""The REAL open-source engines (Tesseract and OpenCV), not the fakes used by the integration tests.
Skipped where Tesseract or the models are not installed (they are in the Docker image the API runs from)."""
from __future__ import annotations

import io
import shutil
from pathlib import Path

import pytest

from app.domain import docmatch

# (Never call get_settings() at import time here: it is cached, and the integration tests set their environment after collection.)
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
