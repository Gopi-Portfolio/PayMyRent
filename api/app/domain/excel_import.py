"""Excel bulk onboarding: safe parsing, row validation, duplicate & capacity pre-checks.

The importer never evaluates formulas or macros, never overwrites existing ledgers,
and produces a preview that the owner commits explicitly. Commit goes through the
same service functions as manual onboarding (see app/modules/onboarding.py).
"""
from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime

from openpyxl import Workbook, load_workbook

from openpyxl.worksheet.datavalidation import DataValidation

from .money import parse_inr
from .places import normalize_kind
from .validation import (
    ValidationError,
    normalize_email,
    normalize_indian_mobile,
    validate_address,
    validate_date_range,
    validate_due_day,
    validate_full_name,
    validate_note,
    validate_pincode,
    validate_unit_identifier,
)

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
MAX_ROWS = 1000
SHEET = "Tenancies"

COLUMNS: list[tuple[str, bool, str]] = [
    # key, required, help text (shown on the Instructions sheet)
    ("property_address", True, "Building address, 5–250 characters"),
    ("property_name", False, "Short name, e.g. 'Main Bazaar Complex'"),
    ("city", False, ""),
    ("state", False, ""),
    ("pincode", False, "6 digits"),
    ("unit_identifier", True, "Door / shop / room number or a short description, up to 80 characters"),
    ("unit_kind", False, "residential or commercial (default commercial)"),
    ("tenant_name", True, "2–100 characters, any Indian script"),
    ("tenant_mobile", True, "10-digit Indian mobile"),
    ("monthly_rent", True, "Rupees, e.g. 10000 or 10000.50"),
    ("due_day", True, "1–31; 29–31 fall on month end in short months"),
    ("start_date", True, "DD-MM-YYYY"),
    ("security_deposit", True, "Rupees; 0 if none"),
    ("tenant_email", False, ""),
    ("tenant_alt_mobile", False, ""),
    ("end_date", False, "DD-MM-YYYY, after start date"),
    ("opening_arrears", False, "Unpaid amount carried in from before RentMeezy"),
    ("notes", False, "Up to 250 characters"),
]
REQUIRED = {k for k, req, _ in COLUMNS if req}
_DANGEROUS_PREFIX = ("=", "+", "-", "@", "\t", "\r", "|")


class ImportFileError(ValueError):
    def __init__(self, code: str, **params: object) -> None:
        super().__init__(code)
        self.code = code
        self.params = params


@dataclass
class ImportRow:
    row_number: int
    data: dict
    errors: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    unit_key: tuple[str, str] | None = None
    is_new_unit: bool = True

    @property
    def valid(self) -> bool:
        return not self.errors


@dataclass
class ImportPreview:
    file_sha256: str
    rows: list[ImportRow]
    new_units: int
    remaining_capacity: int | None
    file_errors: list[dict]

    @property
    def can_commit(self) -> bool:
        return not self.file_errors and any(r.valid for r in self.rows)


def _check_container(content: bytes) -> None:
    if len(content) > MAX_FILE_BYTES:
        raise ImportFileError("file_too_large", max_mb=2)
    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile:
        raise ImportFileError("not_xlsx") from None
    names = zf.namelist()
    if "[Content_Types].xml" not in names or not any(n.startswith("xl/") for n in names):
        raise ImportFileError("not_xlsx")
    if any("vbaProject" in n or n.lower().endswith((".bin", ".exe", ".dll")) for n in names):
        raise ImportFileError("macros_not_allowed")
    if any(n.startswith("xl/externalLinks/") for n in names):
        raise ImportFileError("external_links_not_allowed")
    if sum(i.file_size for i in zf.infolist()) > MAX_UNCOMPRESSED_BYTES:
        raise ImportFileError("file_too_large", max_mb=2)


def _cell_text(v: object) -> str | None:
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s or None


def _parse_date(v: object, fieldname: str) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = _cell_text(v)
    if not s:
        raise ValidationError(fieldname, "required")
    for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValidationError(fieldname, "date_invalid")


def parse_workbook(
    content: bytes,
    *,
    existing_unit_keys: set[tuple[str, str]],
    units_with_live_tenancy: set[tuple[str, str]],
    owner_phones: set[str],
    remaining_capacity: int | None,
) -> ImportPreview:
    """Validate an uploaded workbook without touching the database.

    existing_unit_keys: (lower(address), lower(unit_identifier)) the owner already has.
    units_with_live_tenancy: subset of those already occupied/invited.
    remaining_capacity: active-unit headroom on the owner's plan (None = no active plan).
    """
    _check_container(content)
    sha = hashlib.sha256(content).hexdigest()
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=False, keep_links=False)
    except Exception:  # noqa: BLE001 - any parser failure is a user-facing "unreadable file"
        raise ImportFileError("unreadable_file") from None
    ws = wb[SHEET] if SHEET in wb.sheetnames else wb.worksheets[0]

    rows_iter = ws.iter_rows(values_only=False)
    try:
        header_cells = next(rows_iter)
    except StopIteration:
        raise ImportFileError("empty_file") from None
    headers = [(_cell_text(c.value) or "").lower().replace("*", "").strip().replace(" ", "_") for c in header_cells]
    missing = [k for k in REQUIRED if k not in headers]
    if missing:
        raise ImportFileError("missing_columns", columns=sorted(missing))

    out: list[ImportRow] = []
    seen_units: dict[tuple[str, str], int] = {}
    for idx, cells in enumerate(rows_iter, start=2):
        raw: dict[str, object] = {}
        formula_cols: list[str] = []
        for h, c in zip(headers, cells):
            if not h:
                continue
            if getattr(c, "data_type", None) == "f":
                formula_cols.append(h)
            raw[h] = c.value
        if all(v is None or str(v).strip() == "" for v in raw.values()):
            continue
        if len(out) >= MAX_ROWS:
            raise ImportFileError("too_many_rows", max=MAX_ROWS)
        row = ImportRow(row_number=idx, data={})
        for col in formula_cols:
            row.errors.append({"field": col, "code": "formula_not_allowed"})
        for k, v in raw.items():
            if isinstance(v, str) and v.lstrip().startswith(_DANGEROUS_PREFIX) and k not in ("monthly_rent", "security_deposit", "opening_arrears"):
                row.errors.append({"field": k, "code": "unsafe_cell_content"})
        if row.errors:
            out.append(row)
            continue
        _validate_row(row, raw)
        if row.valid:
            key = (row.data["property_address"].lower(), row.data["unit_identifier"].lower())
            row.unit_key = key
            if key in seen_units:
                row.errors.append({"field": "unit_identifier", "code": "duplicate_in_file", "row": seen_units[key]})
            else:
                seen_units[key] = idx
            if key in units_with_live_tenancy:
                row.errors.append({"field": "unit_identifier", "code": "unit_already_occupied"})
            row.is_new_unit = key not in existing_unit_keys
            if row.data["tenant_mobile"] in owner_phones:
                row.errors.append({"field": "tenant_mobile", "code": "tenant_is_owner"})
        out.append(row)

    file_errors: list[dict] = []
    new_units = sum(1 for r in out if r.valid and r.is_new_unit)
    if remaining_capacity is None:
        file_errors.append({"code": "subscription_required"})
    elif new_units > remaining_capacity:
        file_errors.append({"code": "capacity_exceeded", "new_units": new_units, "remaining": remaining_capacity})
    if not out:
        file_errors.append({"code": "no_rows"})
    return ImportPreview(sha, out, new_units, remaining_capacity, file_errors)


def _validate_row(row: ImportRow, raw: dict[str, object]) -> None:
    def run(fieldname: str, fn):  # noqa: ANN001
        try:
            return fn()
        except ValidationError as e:
            row.errors.append({"field": fieldname, "code": e.code, **{k: v for k, v in e.params.items()}})
            return None

    d = row.data
    d["property_address"] = run("property_address", lambda: validate_address(_cell_text(raw.get("property_address")), required=True))
    d["property_name"] = _cell_text(raw.get("property_name"))
    d["city"] = _cell_text(raw.get("city"))
    d["state"] = _cell_text(raw.get("state"))
    d["pincode"] = run("pincode", lambda: validate_pincode(_cell_text(raw.get("pincode"))))
    kind = (_cell_text(raw.get("unit_kind")) or "commercial").lower()
    d["unit_identifier"] = run("unit_identifier", lambda: validate_unit_identifier(_cell_text(raw.get("unit_identifier")) or ""))
    if kind not in ("residential", "commercial", "shop", "office", "house", "flat", "other"):
        row.errors.append({"field": "unit_kind", "code": "invalid_choice"})
    d["unit_kind"] = normalize_kind(kind)
    d["tenant_name"] = run("tenant_name", lambda: validate_full_name(_cell_text(raw.get("tenant_name")) or "", "tenant_name"))
    d["tenant_mobile"] = run("tenant_mobile", lambda: normalize_indian_mobile(_cell_text(raw.get("tenant_mobile")) or "", "tenant_mobile"))
    d["monthly_rent_paise"] = run("monthly_rent", lambda: parse_inr(_cell_text(raw.get("monthly_rent")), field="monthly_rent", allow_zero=True))
    d["due_day"] = run("due_day", lambda: validate_due_day(raw.get("due_day")))
    d["start_date"] = run("start_date", lambda: _parse_date(raw.get("start_date"), "start_date"))
    d["deposit_paise"] = run("security_deposit", lambda: parse_inr(_cell_text(raw.get("security_deposit")) or "0", field="security_deposit", allow_zero=True))
    email = _cell_text(raw.get("tenant_email"))
    d["tenant_email"] = run("tenant_email", lambda: normalize_email(email, "tenant_email")) if email else None
    alt = _cell_text(raw.get("tenant_alt_mobile"))
    d["tenant_alt_mobile"] = run("tenant_alt_mobile", lambda: normalize_indian_mobile(alt, "tenant_alt_mobile")) if alt else None
    end = raw.get("end_date")
    d["end_date"] = run("end_date", lambda: _parse_date(end, "end_date")) if _cell_text(end) or isinstance(end, (date, datetime)) else None
    if d["start_date"] and d["end_date"]:
        run("end_date", lambda: validate_date_range(d["start_date"], d["end_date"]))
    arrears = _cell_text(raw.get("opening_arrears"))
    d["opening_arrears_paise"] = run("opening_arrears", lambda: parse_inr(arrears, field="opening_arrears", allow_zero=True)) if arrears else 0
    note = _cell_text(raw.get("notes"))
    d["notes"] = run("notes", lambda: validate_note(note, "notes")) if note else None
    if d.get("tenant_alt_mobile") and d.get("tenant_alt_mobile") == d.get("tenant_mobile"):
        row.warnings.append({"field": "tenant_alt_mobile", "code": "same_as_primary"})
    if d["start_date"] and d["start_date"] > date.today().replace(year=date.today().year + 1):
        row.warnings.append({"field": "start_date", "code": "far_future"})


def build_template() -> bytes:
    wb = Workbook()
    ins = wb.active
    ins.title = "Instructions"
    ins.append(["RentMeezy bulk tenancy import"])
    ins.append(["Fill the 'Tenancies' sheet. Columns marked * are required. One row per place (residential or commercial)."])
    ins.append(["Do not use formulas. Amounts are in rupees. Dates as DD-MM-YYYY."])
    ins.append(["Existing places are matched by address + number and are never overwritten."])
    ins.append([])
    ins.append(["Column", "Required", "Notes"])
    for k, req, help_ in COLUMNS:
        ins.append([k, "yes" if req else "", help_])
    ws = wb.create_sheet(SHEET)
    ws.append([k + ("*" if req else "") for k, req, _ in COLUMNS])
    ws.append(["12 Market Road, Madurai", "Main Bazaar", "Madurai", "Tamil Nadu", "625001", "S-01", "commercial",
               "Ravi Kumar", "9876543210", 10000, 5, "01-04-2026", 30000, "", "", "", 0, ""])
    ws.append(["12 Market Road, Madurai", "Main Bazaar", "Madurai", "Tamil Nadu", "625001", "S-02", "commercial",
               "செல்வி", "9123456780", 8500, 10, "15-06-2026", 25000, "selvi@example.com", "", "", 4500, "Opening arrears from June"])
    dv = DataValidation(type="list", formula1='"residential,commercial"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("G2:G1001")
    for col, width in zip("ABCDEFGHIJKLMNOPQR", (32, 18, 12, 14, 9, 12, 9, 22, 13, 12, 8, 12, 14, 24, 14, 12, 14, 30)):
        ws.column_dimensions[col].width = width
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
