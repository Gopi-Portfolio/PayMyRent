"""Names for places: the floor of a building."""
from __future__ import annotations


def floor_name(n: int | None) -> str:
    """0 -> "Ground floor", 1 -> "1st floor", 2 -> "2nd floor" ... 10 -> "10th floor". None -> ""."""
    if n is None:
        return ""
    n = int(n)
    if n == 0:
        return "Ground floor"
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix} floor"


LEGACY_RESIDENTIAL = ("house", "flat", "residential")


def normalize_kind(kind: str | None) -> str:
    """Only two kinds of place exist: 'residential' and 'commercial'. Older names are mapped: house / flat -> residential; shop / office / other -> commercial."""
    return "residential" if (kind or "").lower() in LEGACY_RESIDENTIAL else "commercial"
