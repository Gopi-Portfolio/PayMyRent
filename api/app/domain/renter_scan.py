"""Reading a new renter's name and mobile number from the text of a photographed ID card, rent agreement or visiting card.

Only these two things are ever returned, and only as SUGGESTIONS for the owner to check (OCR is noisy). No ID number (Aadhaar, PAN or any other)
is returned, and nothing from the photo is kept: the caller does not store the image or the text.
"""
from __future__ import annotations

import re

# a 12-digit Aadhaar number (printed in groups of four): taken out first so a stretch of it can never be mistaken for a mobile number
_AADHAAR = re.compile(r"(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)")
# an Indian mobile number: starts 6-9, ten digits, optionally written 5+5 or with +91 / 91 / 0 in front
_MOBILE = re.compile(r"(?<!\d)(?:\+?\s?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5}|[6-9]\d{9})(?!\d)")

_LABEL = re.compile(r"^\s*(?:name\s+of\s+(?:the\s+)?(?:tenant|lessee|renter|applicant)|tenant\s+name|lessee\s+name|name|tenant|lessee|renter|applicant)\s*[:\-–]\s*(.+?)\s*$", re.I)
_TITLE = re.compile(r"\b(?:mr|mrs|ms|miss|smt|shri|sri|thiru|selvi|kumari)\.?\s+([A-Za-z][A-Za-z.]*(?:\s+[A-Za-z][A-Za-z.]*){0,3})", re.I)
_TENANT_WORD = re.compile(r"tenant|lessee|renter|hereinafter\s+called\s+the\s+(?:tenant|lessee)", re.I)

# lines that are printed on the document itself, never a person's name
_NOT_A_NAME = re.compile(
    r"\b(?:name|government|govt|india|unique|identification|authority|income\s*tax|department|permanent|account|number|aadhaar|aadhar|enrol|male|female|dob|birth|"
    r"year|address|signature|father|mother|husband|wife|card|vid|tenancy|agreement|rent|lease|deed|between|landlord|lessor|owner|witness|date|"
    r"mobile|phone|email|e-mail|www|http|download|verify|issued|valid|resident|authorised|signatory|stamp|rupees|rs\.?|month|monthly|deposit|mobiles?|sales|services?|stores?|traders?|enterprises?|company|pvt|ltd|limited|textiles?|medicals?|shop|centre|center|agency|works|hotel|restaurant|bakery|jewellers?)\b",
    re.I)


def find_mobile(text: str) -> str | None:
    """The first mobile number in the text, as ten digits."""
    cleaned = _AADHAAR.sub(" ", text)
    for m in _MOBILE.finditer(cleaned):
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) == 10:
            return digits
    return None


def _clean_name(raw: str) -> str | None:
    # cut at the first thing that is not part of a name: a bracket, a digit, "s/o", "d/o", "w/o", a comma
    raw = re.split(r"[(\[,;:/\d]|\b(?:s/o|d/o|w/o|c/o|son of|daughter of|wife of)\b", raw, maxsplit=1, flags=re.I)[0]
    name = re.sub(r"[^A-Za-z .]", " ", raw)
    name = re.sub(r"\s+", " ", name).strip(" .")
    words = [w for w in name.split(" ") if w]
    if not 2 <= len(words) <= 5 and not (len(words) == 1 and len(words[0]) >= 4):
        return None
    if sum(len(w.strip(".")) for w in words) < 3 or any(len(w.strip(".")) == 0 for w in words):
        return None
    if _NOT_A_NAME.search(name):
        return None
    return name.upper()


_RELATION = re.compile(r"\b[sdwc]\s*/\s*o\b", re.I)         # "S/o", "D/o", "W/o", "C/o": what follows is a parent or spouse, not part of the name


def find_name(text: str) -> str | None:
    """The renter's name: a labelled one ("Name: ..."), else the one named as tenant/lessee, else a titled one ("Mr. ..."), else a plain name line."""
    text = _RELATION.sub(",", text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for ln in lines:                                                  # 1. "Name: Ravi Kumar", "Tenant: Selvi"
        m = _LABEL.match(ln)
        if m and (name := _clean_name(m.group(1))):
            return name
    titled = [(m.start(), m) for m in _TITLE.finditer(text)]
    for pos, m in titled:                                             # 2. an agreement: "Mr. X ... (hereinafter called the Tenant)"
        tail = text[m.end(): m.end() + 120]
        if _TENANT_WORD.search(tail.split(")")[0] + ")" if ")" in tail else tail[:80]) and (name := _clean_name(m.group(1))):
            return name
    for pos, m in titled:                                             # 3. any titled name
        if name := _clean_name(m.group(1)):
            return name
    for ln in lines:                                                  # 4. a line that is just a name (an ID card prints it on its own line)
        if re.fullmatch(r"[A-Za-z][A-Za-z .]{2,60}", ln) and (name := _clean_name(ln)):
            return name
    return None


def extract_renter_details(text: str) -> dict:
    """{'name': 'RAVI KUMAR' | None, 'mobile': '9876543210' | None}"""
    return {"name": find_name(text or ""), "mobile": find_mobile(text or "")}
