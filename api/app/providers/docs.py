"""Document engines for the automatic owner check: read the text on a photo (Tesseract) and compare two faces (OpenCV YuNet + SFace).

Both are free and open source and run on our own server, so nothing leaves it and nothing is paid per check. They are less accurate
than paid services: a blurry photo simply fails and the owner is asked to take it again. The thresholds are settings (RG_DOC_*), so
they can be tuned from real photos without a new app build.

Heavy libraries are imported only when a photo is processed, so the API starts (and the tests run) without them.
"""
from __future__ import annotations

import io
import threading
from pathlib import Path
from typing import Protocol

from ..core.config import get_settings

MAX_SIDE = 2000                      # larger photos are scaled down before processing: bounds time and memory
MAX_PIXELS = 30_000_000              # refuse decompression bombs
_gate = threading.BoundedSemaphore(2)       # at most two photos processed at once, so the machine that also serves users is not starved


class BadImage(ValueError):
    """The bytes are not a usable JPEG/PNG photo."""


class DocEngine(Protocol):
    def read_text(self, image: bytes) -> str: ...
    def face_score(self, selfie: bytes, card: bytes) -> tuple[float | None, str]:
        """(similarity, '') or (None, 'selfie' | 'card') naming the photo in which no face was found."""
        ...


def inspect_image(data: bytes) -> tuple[str, int, int]:
    """Validate an upload: a real JPEG or PNG of sensible size. Returns (mime, width, height)."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as im:
            im.verify()
        with Image.open(io.BytesIO(data)) as im:
            fmt, (w, h) = im.format, im.size
    except Exception as e:       # noqa: BLE001 - anything unreadable is simply "not an image"
        raise BadImage("not a readable image") from e
    if fmt not in ("JPEG", "PNG"):
        raise BadImage("only JPEG or PNG photos are accepted")
    return ("image/jpeg" if fmt == "JPEG" else "image/png"), w, h


def _decode(data: bytes):
    """Photo bytes -> upright BGR numpy array, scaled down to MAX_SIDE."""
    import numpy as np
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")      # phones store rotation in a tag
            if max(im.size) > MAX_SIDE:
                im.thumbnail((MAX_SIDE, MAX_SIDE))
            return np.array(im)[:, :, ::-1].copy()
    except Exception as e:       # noqa: BLE001
        raise BadImage("not a readable image") from e


class LocalEngine:
    def __init__(self) -> None:
        self._det = self._rec = None
        self._lock = threading.Lock()

    # -- text
    def read_text(self, image: bytes) -> str:
        import cv2
        import pytesseract
        s = get_settings()
        img = _decode(image)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)      # even out phone-camera lighting
        with _gate:
            try:
                return pytesseract.image_to_string(gray, lang=s.doc_ocr_langs, timeout=45)
            except RuntimeError:                      # tesseract timed out
                return ""

    # -- faces
    def _models(self):
        import cv2
        with self._lock:
            if self._det is None:
                d = Path(get_settings().doc_models_dir)
                self._det = cv2.FaceDetectorYN.create(str(d / "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.5, 0.3, 5000)
                self._rec = cv2.FaceRecognizerSF.create(str(d / "face_recognition_sface_2021dec.onnx"), "")
        return self._det, self._rec

    def _faces(self, img):
        det, _ = self._models()
        h, w = img.shape[:2]
        det.setInputSize((w, h))
        _, faces = det.detect(img)
        return [] if faces is None else list(faces)

    def face_score(self, selfie: bytes, card: bytes) -> tuple[float | None, str]:
        import cv2
        _, rec = self._models()
        with _gate:
            a = _decode(selfie)
            fa = self._faces(a)
            if not fa:
                return None, "selfie"
            sel = max(fa, key=lambda f: f[2] * f[3])
            fsel = rec.feature(rec.alignCrop(a, sel))
            c = _decode(card)
            if c.shape[1] < 1200:                                         # the photo on a card is tiny: enlarge so it can be found
                scale = 1200 / c.shape[1]
                c = cv2.resize(c, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            for rot in (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
                img = c if rot is None else cv2.rotate(c, rot)           # the card may have been photographed sideways
                fc = self._faces(img)
                if fc:
                    best = max(float(rec.match(fsel, rec.feature(rec.alignCrop(img, f)), cv2.FaceRecognizerSF_FR_COSINE)) for f in fc)
                    return best, ""
            return None, "card"


_engine: DocEngine | None = None


def get_engine() -> DocEngine:
    global _engine
    if _engine is None:
        _engine = LocalEngine()
    return _engine
