"""Field validation shared by the API, the Excel importer and the job runner.

Every rule here is mirrored in the mobile app (mobile/src/lib/validation.ts) for
instant feedback, but the server is authoritative. Error codes are stable keys
that both sides translate (see app/i18n/*.json and mobile/src/i18n/*.json).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date

try:  # The `regex` package implements full UAX #29 grapheme clusters; prefer it when installed.
    import regex as _regex  # type: ignore
except ImportError:  # pragma: no cover - exercised in minimal environments
    _regex = None


class ValidationError(ValueError):
    def __init__(self, field: str, code: str, **params: object) -> None:
        super().__init__(f"{field}: {code}")
        self.field = field
        self.code = code
        self.params = params


# ───────────────────────── Unicode helpers ─────────────────────────
_VIRAMAS = {"्", "্", "੍", "્", "୍", "்", "్", "್", "്"}
_ZWJ, _ZWNJ = "‍", "‌"
_CONTROL_OK = {"\n"}


def grapheme_count(text: str) -> int:
    """Count user-perceived characters (what the note counter shows).

    Uses `regex` \\X when available. The fallback implements the parts of UAX #29
    that matter for Indian scripts and emoji: combining marks/vowel signs extend
    the previous cluster, a virama joins the next consonant into a conjunct
    (e.g. क्ष is one), ZWJ sequences and skin-tone/variation selectors attach, and
    regional-indicator flags pair up.
    """
    if _regex is not None:
        return len(_regex.findall(r"\X", text))
    count = 0
    prev = ""
    ri_open = False
    for ch in text:
        cat = unicodedata.category(ch)
        joins = (
            cat in ("Mn", "Mc", "Me")
            or ch in (_ZWJ, _ZWNJ)
            or 0xFE00 <= ord(ch) <= 0xFE0F
            or 0x1F3FB <= ord(ch) <= 0x1F3FF
            or (prev in _VIRAMAS and cat == "Lo")
            or prev == _ZWJ
        )
        is_ri = 0x1F1E6 <= ord(ch) <= 0x1F1FF
        if is_ri and ri_open:
            joins, ri_open = True, False
        elif is_ri:
            ri_open = True
        else:
            ri_open = False
        if not joins or count == 0:
            count += 1
        prev = ch
    return count


def clean_text(value: str) -> str:
    """NFC-normalise, collapse runs of spaces, strip, and reject control characters."""
    value = unicodedata.normalize("NFC", value)
    for ch in value:
        if unicodedata.category(ch) in ("Cc", "Cs", "Co") and ch not in _CONTROL_OK:
            raise ValidationError("text", "invalid_characters")
        if ch in "‪‫‬‭‮⁦⁧⁨⁩":  # bidi overrides
            raise ValidationError("text", "invalid_characters")
    return re.sub(r"[ \t ]+", " ", value).strip()


# ───────────────────────── fields ─────────────────────────
_NAME_PUNCT = set(" .'-,()&/")


def validate_full_name(raw: str, field: str = "full_name") -> str:
    value = clean_text(raw or "")
    n = grapheme_count(value)
    if n < 2:
        raise ValidationError(field, "too_short", min=2)
    if n > 100:
        raise ValidationError(field, "too_long", max=100)
    has_letter = False
    for ch in value:
        cat = unicodedata.category(ch)
        if cat.startswith("L"):
            has_letter = True
        elif cat.startswith("M") or ch in _NAME_PUNCT or ch in (_ZWJ, _ZWNJ):
            continue
        elif cat == "Nd":
            continue  # allowed alongside letters (e.g. "Shop 2 Traders"), but not digits-only
        else:
            raise ValidationError(field, "invalid_characters")
    if not has_letter:
        raise ValidationError(field, "must_contain_letters")
    return value


_MOBILE_RE = re.compile(r"^[6-9]\d{9}$")


def normalize_indian_mobile(raw: str, field: str = "mobile") -> str:
    """Accepts '98765 43210', '+91 98765-43210', '091…', '919876543210' → '+919876543210'."""
    if raw is None:
        raise ValidationError(field, "required")
    digits = "".join(ch for ch in str(raw) if ch.isdigit())
    # Normalise Unicode digits (e.g. Devanagari) to ASCII.
    digits = "".join(str(unicodedata.digit(ch)) for ch in digits)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) != 10:
        raise ValidationError(field, "mobile_10_digits")
    if not _MOBILE_RE.match(digits):
        raise ValidationError(field, "mobile_invalid_prefix")
    return "+91" + digits


_EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def normalize_email(raw: str, field: str = "email") -> str:
    value = (raw or "").strip()
    if len(value) > 254:
        raise ValidationError(field, "too_long", max=254)
    local, _, domain = value.rpartition("@")
    if not local or len(local) > 64 or ".." in value or not _EMAIL_RE.match(value):
        raise ValidationError(field, "email_invalid")
    return local + "@" + domain.lower()


def validate_address(raw: str | None, *, required: bool, field: str = "address") -> str | None:
    if raw is None or not raw.strip():
        if required:
            raise ValidationError(field, "required")
        return None
    value = clean_text(raw)
    n = grapheme_count(value)
    if required and n < 5:
        raise ValidationError(field, "too_short", min=5)
    if n > 250:
        raise ValidationError(field, "too_long", max=250)
    return value


_UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/ -]{0,19}$")


_PLACE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/ ,.&#+()'-]{0,79}$")


def validate_unit_identifier(raw: str, field: str = "unit_identifier", kind: str = "commercial") -> str:
    """The door / shop / room number of a place, or a short description ("12", "4B", "Flat 3", "S-01", "10-50 hostel", "2 shops, 5 houses"). Same for both kinds."""
    value = re.sub(r"\s+", " ", (raw or "").strip())
    if not value:
        raise ValidationError(field, "required")
    if len(value) > 80:
        raise ValidationError(field, "too_long", max=80)
    if not _PLACE_RE.match(value):
        raise ValidationError(field, "unit_identifier_chars")
    return value


def validate_pincode(raw: str | None, field: str = "pincode") -> str | None:
    if raw is None or str(raw).strip() == "":
        return None
    value = str(raw).strip()
    if not re.fullmatch(r"[1-9]\d{5}", value):
        raise ValidationError(field, "pincode_6_digits")
    return value


def validate_due_day(raw: object, field: str = "due_day") -> int:
    try:
        if isinstance(raw, bool):
            raise TypeError
        value = int(str(raw).strip()) if not isinstance(raw, int) else raw
        if isinstance(raw, float) and raw != int(raw):
            raise TypeError
    except (TypeError, ValueError):
        raise ValidationError(field, "integer_required") from None
    if not 1 <= value <= 31:
        raise ValidationError(field, "out_of_range", min=1, max=31)
    return value


NOTE_MAX = 250


def validate_note(raw: str, field: str = "body") -> str:
    value = clean_text(raw or "")
    n = grapheme_count(value)
    if n < 1:
        raise ValidationError(field, "required")
    if n > NOTE_MAX:
        raise ValidationError(field, "too_long", max=NOTE_MAX, actual=n)
    return value


def validate_date_range(start: date, end: date | None) -> None:
    if end is not None and end <= start:
        raise ValidationError("end_date", "end_before_start")


SUPPORTED_LANGUAGES = ("en", "ta", "hi", "te", "kn", "ml", "mr", "bn")


def validate_language(raw: str) -> str:
    if raw not in SUPPORTED_LANGUAGES:
        raise ValidationError("preferred_language", "unsupported_language")
    return raw


@dataclass(frozen=True)
class FieldRule:
    """Machine-readable rule table, served at GET /api/v1/meta/validation for the app."""
    field: str
    required: bool
    min: int | None
    max: int | None
    notes: str


FIELD_RULES: tuple[FieldRule, ...] = (
    FieldRule("full_name", True, 2, 100, "Unicode letters/marks, spaces, . ' - , ( ) & /; digits only alongside letters"),
    FieldRule("mobile", True, 10, 10, "Indian mobile; +91/0 prefixes stripped; must start 6–9"),
    FieldRule("email", False, 3, 254, "RFC 5322 subset; domain lower-cased; max 2 per user"),
    FieldRule("profile_address", False, 0, 250, "graphemes"),
    FieldRule("property_address", True, 5, 250, "graphemes"),
    FieldRule("unit_identifier", True, 1, 20, "A–Z a–z 0–9 space / -"),
    FieldRule("pincode", False, 6, 6, "first digit 1–9"),
    FieldRule("amount", True, 0, None, "INR, ≤2 decimals, no exponent; payments > 0; max ₹1,00,00,000"),
    FieldRule("due_day", True, 1, 31, "29–31 fall on month end in shorter months"),
    FieldRule("note", False, 1, 250, "graphemes; typed or reviewed voice transcript"),
)


ITEMS_MAX = 2000


def validate_items(raw: str | None, field: str = "items_provided") -> str | None:
    """The list of items provided with a rental: free text, commas or new lines. Control characters are refused, blank lines are squeezed."""
    if raw is None or not raw.strip():
        return None
    value = clean_text(raw.replace("\r\n", "\n").replace("\r", "\n"))
    value = re.sub(r"[ \t]*\n[ \t]*", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    if grapheme_count(value) > ITEMS_MAX:
        raise ValidationError(field, "too_long", max=ITEMS_MAX)
    return value or None
