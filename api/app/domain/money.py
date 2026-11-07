"""INR amounts as integer paise. No float ever touches money."""
from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal

from .validation import ValidationError

MAX_AMOUNT_PAISE = 10_000_000_00  # ₹1,00,00,000 — sanity ceiling for a single entry
_AMOUNT_RE = re.compile(r"^\d{1,9}(\.\d{1,2})?$")


def parse_inr(raw: object, *, field: str = "amount", allow_zero: bool = False) -> int:
    """'7000', '7,000.50', '₹ 7000', 7000 (int) → paise. Rejects floats, NaN, exponents, negatives."""
    if isinstance(raw, bool) or raw is None:
        raise ValidationError(field, "amount_invalid")
    if isinstance(raw, float):
        # JSON numbers arrive as floats; accept only if they round-trip exactly to 2dp.
        text = repr(raw)
        if "e" in text.lower() or raw != raw:
            raise ValidationError(field, "amount_invalid")
    elif isinstance(raw, (int, Decimal)):
        text = str(raw)
    else:
        text = str(raw)
    text = text.strip().replace("₹", "").replace(",", "").replace(" ", "")
    if text.startswith("Rs."):
        text = text[3:]
    if not _AMOUNT_RE.match(text):
        raise ValidationError(field, "amount_invalid")
    paise = int((Decimal(text) * 100).to_integral_value(rounding=ROUND_HALF_UP))
    if paise == 0 and not allow_zero:
        raise ValidationError(field, "amount_must_be_positive")
    if paise > MAX_AMOUNT_PAISE:
        raise ValidationError(field, "amount_too_large", max=MAX_AMOUNT_PAISE // 100)
    return paise


def format_inr(paise: int, *, symbol: bool = True) -> str:
    """Indian digit grouping: 1234567.5 → ₹12,34,567.50 (whole rupees shown without decimals)."""
    sign = "-" if paise < 0 else ""
    paise = abs(paise)
    rupees, p = divmod(paise, 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join(groups) + "," + tail
    out = s if p == 0 else f"{s}.{p:02d}"
    return f"{sign}{'₹' if symbol else ''}{out}"


def prorate(monthly_paise: int, days: int, days_in_month: int) -> int:
    """Mirror of the SQL proration (round half away from zero) for previews."""
    if not (0 <= days <= days_in_month):
        raise ValueError("days out of range")
    q = Decimal(monthly_paise) * days / days_in_month
    return int(q.to_integral_value(rounding=ROUND_HALF_UP))
