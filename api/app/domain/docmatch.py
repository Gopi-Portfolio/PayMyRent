"""Pure text helpers for the automatic document check (no image libraries, easy to test).

OCR output is noisy, so names are compared loosely: letters only, any word order, and a word counts as found when a similar word
(about 85% alike) is in the text. These are screening checks, not proof: see docs/DECISIONS.md D-21.
"""
from __future__ import annotations

import re
from datetime import date
from difflib import SequenceMatcher

_PAN_TYPE = "PCHFATBLJG"          # 4th letter of a PAN: person, company, HUF, firm, AOP, trust, local authority, juridical person, government
_TO_LETTER = {"0": "O", "1": "I", "5": "S", "8": "B", "2": "Z"}
_TO_DIGIT = {"O": "0", "I": "1", "L": "1", "S": "5", "B": "8", "Z": "2", "D": "0", "G": "6"}
_STOP = {"S", "O", "D", "W", "MR", "MRS", "MS", "SMT", "SHRI", "SRI", "LATE"}      # "son of", titles


def words(text: str) -> list[str]:
    """Upper-case words of letters (any script), digits and punctuation dropped."""
    return [w for w in re.sub(r"[^\w\s]|[\d_]", " ", text.upper()).split() if w]


def name_tokens(name: str) -> list[str]:
    return [w for w in words(name) if len(w) > 1 and w not in _STOP]


def _alike(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def name_similarity(a: str, b: str) -> float:
    """Whole-name similarity ignoring word order (0..1)."""
    ta, tb = sorted(name_tokens(a)), sorted(name_tokens(b))
    return _alike(" ".join(ta), " ".join(tb)) if ta and tb else 0.0


def name_in_text(name: str, text: str, minimum: float = 0.8, word_alike: float = 0.8) -> bool:
    """Is (almost) every word of the name somewhere in the text?"""
    tokens = name_tokens(name)
    if not tokens:
        return False
    pool = set(words(text))
    found = sum(1 for t in tokens if t in pool or any(_alike(t, w) >= word_alike for w in pool if abs(len(w) - len(t)) <= 2))
    return found / len(tokens) >= minimum and found >= min(2, len(tokens))


def address_in_text(address: str, pincode: str | None, text: str, minimum: float = 0.5) -> bool:
    """The property's address on the deed: the pincode is written in it, or at least half of the address words are."""
    if pincode and re.search(rf"(?<!\d){re.escape(pincode)}(?!\d)", re.sub(r"(?<=\d)\s+(?=\d)", "", text)):
        return True
    toks = [w for w in words(address) if len(w) >= 3]
    if not toks:
        return False
    pool = set(words(text))
    found = sum(1 for t in toks if t in pool or any(_alike(t, w) >= 0.85 for w in pool if abs(len(w) - len(t)) <= 2))
    return found / len(toks) >= minimum


def find_pan(text: str) -> str | None:
    """The PAN on a card photo, tolerating the usual OCR mix-ups (0/O, 1/I, 5/S, 8/B)."""
    flat = re.sub(r"[^A-Z0-9]", "", text.upper())
    for i in range(len(flat) - 9):
        w = flat[i:i + 10]
        pan = "".join(_TO_LETTER.get(c, c) if k < 5 or k == 9 else _TO_DIGIT.get(c, c) for k, c in enumerate(w))
        if re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", pan) and pan[3] in _PAN_TYPE:
            return pan
    return None


def pan_name_region(text: str) -> str:
    """The text above the 'Father's Name' line, so a surname shared with the father cannot stand in for the holder's own name."""
    m = re.search(r"father|पिता", text, re.I)
    return text[:m.start()] if m else text


def find_birth_date(text: str) -> date | None:
    m = re.search(r"\b(\d{2})\s*[/\-.]\s*(\d{2})\s*[/\-.]\s*(\d{4})\b", text)
    if not m:
        return None
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def age_on(born: date, today: date) -> int:
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


def enough_text(text: str, minimum_words: int = 25) -> bool:
    """A deed page has pages of text; a blank, dark or wrong photo reads as almost nothing."""
    return len(words(text)) >= minimum_words

