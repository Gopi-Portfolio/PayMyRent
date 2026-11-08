"""Pure-logic tests: no database, no network. Run: pytest tests/unit"""
from __future__ import annotations

import io
from datetime import date, datetime, time
from uuid import uuid4

import pytest
from openpyxl import Workbook, load_workbook

from app.domain.excel_import import ImportFileError, build_template, parse_workbook
from app.domain.money import format_inr, parse_inr, prorate
from app.domain.notifications import (
    Contact, Preferences, in_quiet_hours, overdue_days, owner_notice, reminder_offset_due, resolve_destination,
)
from app.domain.signatures import (
    hash_otp, hmac_sha256_hex, mask_phone, sign_token, verify_hmac_sha256_hex, verify_token,
)
from app.domain.validation import (
    ValidationError, grapheme_count, normalize_email, normalize_indian_mobile, validate_address,
    validate_due_day, validate_full_name, validate_note, validate_pincode, validate_unit_identifier,
)


# ───────────── mobile numbers ─────────────
@pytest.mark.parametrize("raw", ["9876543210", "+91 98765 43210", "+91-98765-43210", "919876543210",
                                 "09876543210", " 98765 43210 ", "९८७६५४३२१०"])
def test_mobile_normalises_to_e164(raw):
    assert normalize_indian_mobile(raw) == "+919876543210"


@pytest.mark.parametrize("raw,code", [("987654321", "mobile_10_digits"), ("98765432101", "mobile_10_digits"),
                                      ("5876543210", "mobile_invalid_prefix"), ("", "mobile_10_digits"),
                                      ("+1 415 555 0100", "mobile_10_digits")])
def test_mobile_rejects(raw, code):
    with pytest.raises(ValidationError) as e:
        normalize_indian_mobile(raw)
    assert e.value.code == code


# ───────────── names (Unicode-aware) ─────────────
@pytest.mark.parametrize("name", ["Ravi Kumar", "செல்வி", "राजेश शर्मा", "రామ్ చరణ్", "ಕಾವ್ಯ", "മീര",
                                  "সৌমিত্র", "श्री. के. आर. नायर", "D'Souza", "Shop 2 Traders", "Lakshmi-Narayan"])
def test_names_accepted(name):
    assert validate_full_name(name)


@pytest.mark.parametrize("name,code", [("A", "too_short"), ("12345", "must_contain_letters"),
                                       ("Ravi<script>", "invalid_characters"), ("Ravi\x00", "invalid_characters"),
                                       ("Ravi‮akuK", "invalid_characters"), ("x" * 101, "too_long")])
def test_names_rejected(name, code):
    with pytest.raises(ValidationError) as e:
        validate_full_name(name)
    assert e.value.code == code


def test_name_length_counts_graphemes_not_codepoints():
    tamil = "செ" * 100           # each 'செ' is 2 code points but 1 grapheme
    assert len(tamil) == 200
    assert validate_full_name(tamil)
    with pytest.raises(ValidationError):
        validate_full_name("செ" * 101)


# ───────────── notes: 250 graphemes ─────────────
@pytest.mark.parametrize("unit,expected", [("a", 1), ("க", 1), ("கி", 1), ("क्ष", 1), ("नि", 1), ("👍🏽", 1), ("🇮🇳", 1), ("👨‍👩‍👧", 1)])
def test_grapheme_units(unit, expected):
    assert grapheme_count(unit) == expected


@pytest.mark.parametrize("unit", ["a", "கி", "क्ष", "ಕೃ", "👍🏽"])
def test_note_250_accepted_251_rejected(unit):
    assert validate_note(unit * 250)
    with pytest.raises(ValidationError) as e:
        validate_note(unit * 251)
    assert e.value.code == "too_long" and e.value.params["actual"] == 251


def test_note_empty_rejected():
    with pytest.raises(ValidationError):
        validate_note("   ")


# ───────────── other fields ─────────────
def test_email():
    assert normalize_email("Ravi.K@Example.COM") == "Ravi.K@example.com"
    for bad in ["no-at", "a@b", "a..b@x.com", "a@" + "x" * 250 + ".com"]:
        with pytest.raises(ValidationError):
            normalize_email(bad)


def test_unit_identifier_and_pincode_and_due_day():
    assert validate_unit_identifier("  S-01 / A ") == "S-01 / A"
    assert validate_unit_identifier("Flat 4B,  Block A (rear)") == "Flat 4B, Block A (rear)"          # a door / shop / room number, or a short description
    assert validate_unit_identifier("x" * 80) == "x" * 80
    for bad in ["", "S<1>", "x" * 81, "-S1", "S;1"]:
        with pytest.raises(ValidationError):
            validate_unit_identifier(bad)
    assert validate_pincode("625001") == "625001"
    assert validate_pincode("") is None
    for bad in ["62500", "025001", "6250011", "62500a"]:
        with pytest.raises(ValidationError):
            validate_pincode(bad)
    assert validate_due_day("31") == 31
    for bad in [0, 32, "x", 5.5, True]:
        with pytest.raises(ValidationError):
            validate_due_day(bad)


def test_address_bounds():
    assert validate_address(None, required=False) is None
    with pytest.raises(ValidationError):
        validate_address("abc", required=True)
    assert validate_address("12, காந்தி சாலை, மதுரை", required=True)
    with pytest.raises(ValidationError):
        validate_address("x" * 251, required=False)


# ───────────── money ─────────────
@pytest.mark.parametrize("raw,paise", [("7000", 700000), ("7,000.50", 700050), ("₹ 10,000", 1000000), (7000, 700000),
                                       ("0.01", 1), (7000.5, 700050), ("Rs.250", 25000)])
def test_parse_inr(raw, paise):
    assert parse_inr(raw) == paise


@pytest.mark.parametrize("raw", ["-5", "1e3", "NaN", "7000.505", "abc", float("nan"), 0.1 + 0.2, "100000001", True, None])
def test_parse_inr_rejects(raw):
    with pytest.raises(ValidationError):
        parse_inr(raw)


def test_zero_allowed_only_when_asked():
    with pytest.raises(ValidationError):
        parse_inr("0")
    assert parse_inr("0", allow_zero=True) == 0


def test_format_inr_indian_grouping():
    assert format_inr(123456750) == "₹12,34,567.50"
    assert format_inr(1000000) == "₹10,000"
    assert format_inr(100) == "₹1"
    assert format_inr(-300000) == "-₹3,000"


def test_prorate_matches_sql_rule():
    assert prorate(3000000, 10, 30) == 1000000
    assert prorate(1000000, 1, 31) == 32258   # 32258.06 → 32258
    assert prorate(1000001, 15, 30) == 500001  # 500000.5 → half away from zero


# ───────────── signatures / tokens ─────────────
def test_webhook_signature_uses_raw_bytes():
    body = b'{"event":"payment.captured","amount":100}'
    sig = hmac_sha256_hex("whsec", body)
    assert verify_hmac_sha256_hex("whsec", body, sig)
    assert not verify_hmac_sha256_hex("whsec", body + b" ", sig)
    assert not verify_hmac_sha256_hex("other", body, sig)
    assert not verify_hmac_sha256_hex("whsec", body, None)
    assert not verify_hmac_sha256_hex("", body, sig)


def test_signed_token_roundtrip_and_expiry():
    t = sign_token("s", {"job": "invoices"}, 60)
    assert verify_token("s", t)["job"] == "invoices"
    assert verify_token("x", t) is None
    assert verify_token("s", sign_token("s", {}, -1)) is None
    assert verify_token("s", "garbage") is None


def test_otp_hash_is_bound_to_target():
    assert hash_otp("k", "+919876543210", "123456") != hash_otp("k", "+919876543211", "123456")
    assert mask_phone("+919876543210") == "+91•••••3210"


# ───────────── notifications ─────────────
def _prefs(**kw):
    base = dict(sms_contact_id=None, whatsapp_contact_id=None, email_contact_id=None, sms_enabled=True,
                whatsapp_enabled=True, email_enabled=True, push_enabled=True,
                quiet_start=time(21), quiet_end=time(8))
    base.update(kw)
    return Preferences(**base)


def test_destinations_only_verified_and_consented():
    m1, m2, e1 = (Contact(uuid4(), "mobile", "+919876543210", True), Contact(uuid4(), "mobile", "+919123456780", False),
                  Contact(uuid4(), "email", "a@b.in", False))
    p = _prefs(sms_contact_id=m1.id, whatsapp_contact_id=m2.id, email_contact_id=e1.id)
    assert resolve_destination("sms", p, [m1, m2, e1], {}, False) == ("+919876543210", None)
    assert resolve_destination("whatsapp", p, [m1, m2, e1], {"whatsapp": True}, False) == (None, "no_verified_destination")
    assert resolve_destination("whatsapp", _prefs(whatsapp_contact_id=m1.id), [m1], {}, False) == (None, "no_consent")
    assert resolve_destination("email", p, [m1, m2, e1], {}, False) == (None, "no_verified_destination")
    assert resolve_destination("sms", p, [m1], {"sms": False}, False) == (None, "no_consent")
    assert resolve_destination("push", p, [], {}, False) == (None, "no_device")


def test_quiet_hours_wraps_midnight():
    assert in_quiet_hours(datetime(2026, 11, 5, 22, 0), time(21), time(8))
    assert in_quiet_hours(datetime(2026, 11, 5, 7, 59), time(21), time(8))
    assert not in_quiet_hours(datetime(2026, 11, 5, 8, 0), time(21), time(8))


def test_reminders_stop_when_paid_and_continue_for_partial():
    due = date(2026, 11, 5)
    assert reminder_offset_due(date(2026, 10, 31), due, [-5, -1, 0, 3], 300000, True) == -5
    assert reminder_offset_due(date(2026, 11, 8), due, [-5, -1, 0, 3], 1, True) == 3
    assert reminder_offset_due(date(2026, 11, 5), due, [-5, -1, 0, 3], 0, True) is None
    assert reminder_offset_due(date(2026, 11, 5), due, [-5, -1, 0, 3], 500, False) is None
    assert reminder_offset_due(date(2026, 11, 6), due, [-5, -1, 0, 3], 500, True) is None


# ───────────── Excel import ─────────────
def _xlsx(rows, header=None):
    wb = load_workbook(io.BytesIO(build_template()))
    ws = wb["Tenancies"]
    ws.delete_rows(2, ws.max_row)
    if header is not None:
        ws.delete_rows(1, 1)
        ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _row(unit="S-01", mobile="9876543210", rent=10000, **over):
    r = ["12 Market Road, Madurai", "Main Bazaar", "Madurai", "TN", "625001", unit, "shop", "Ravi Kumar",
         mobile, rent, 5, "01-04-2026", 30000, "", "", "", 0, ""]
    for idx, v in over.items():
        r[int(idx[1:])] = v
    return r


def _parse(content, cap=10, existing=frozenset(), live=frozenset()):
    return parse_workbook(content, existing_unit_keys=set(existing), units_with_live_tenancy=set(live),
                          owner_phones={"+919000000001"}, remaining_capacity=cap)


def test_template_round_trips_as_valid():
    p = _parse(build_template())
    assert [r.valid for r in p.rows] == [True, True]
    assert p.rows[1].data["opening_arrears_paise"] == 450000
    assert p.new_units == 2 and p.can_commit


def test_import_row_errors_and_duplicates():
    content = _xlsx([
        _row(),
        _row(),                                        # duplicate unit in file
        _row(unit="S-03", mobile="12345"),             # bad mobile
        _row(unit="S-04", rent="-100"),                # negative rent
        _row(unit="S-05", c7="=HYPERLINK(\"x\")"),     # formula injection in name
        _row(unit="S-06", mobile="9000000001"),        # owner's own number
        _row(unit="S-07", c15="01-01-2026"),           # end before start
        [None] * 18,                                   # blank rows ignored
        _row(unit="S-08", c12=""),                     # blank deposit → 0 is allowed
    ])
    p = _parse(content)
    codes = {r.row_number: [e["code"] for e in r.errors] for r in p.rows}
    assert codes[2] == []
    assert codes[3] == ["duplicate_in_file"]
    assert codes[4] == ["mobile_10_digits"]
    assert codes[5] == ["amount_invalid"]
    assert "unsafe_cell_content" in codes[6] or "formula_not_allowed" in codes[6]
    assert codes[7] == ["tenant_is_owner"]
    assert codes[8] == ["end_before_start"]
    assert codes[10] == [] and p.rows[-1].data["deposit_paise"] == 0


def test_import_capacity_and_existing_units():
    content = _xlsx([_row(unit=f"S-{i}", mobile=f"98765432{i:02d}") for i in range(1, 6)])
    existing = {("12 market road, madurai", "s-1")}
    p = _parse(content, cap=3, existing=existing)
    assert p.new_units == 4
    assert p.file_errors == [{"code": "capacity_exceeded", "new_units": 4, "remaining": 3}]
    assert not p.can_commit
    p2 = _parse(content, cap=None)
    assert {"code": "subscription_required"} in p2.file_errors
    p3 = _parse(content, cap=10, existing=existing, live=existing)
    assert p3.rows[0].errors == [{"field": "unit_identifier", "code": "unit_already_occupied"}]


def test_import_rejects_unsafe_files():
    with pytest.raises(ImportFileError) as e:
        _parse(b"not a zip")
    assert e.value.code == "not_xlsx"
    with pytest.raises(ImportFileError) as e:
        _parse(b"x" * (3 * 1024 * 1024))
    assert e.value.code == "file_too_large"
    wb = Workbook()
    wb.active.append(["tenant_name"])
    buf = io.BytesIO()
    wb.save(buf)
    with pytest.raises(ImportFileError) as e:
        _parse(buf.getvalue())
    assert e.value.code == "missing_columns"


def test_import_formula_cell_rejected_even_in_numeric_column():
    content = _xlsx([_row(c9="=5000*2")])
    p = _parse(content)
    assert any(e["code"] == "formula_not_allowed" for e in p.rows[0].errors)


def test_import_accepts_real_excel_dates():
    content = _xlsx([_row(c11=datetime(2026, 4, 1))])
    assert _parse(content).rows[0].data["start_date"] == date(2026, 4, 1)


def test_log_redaction_keeps_numbers_numeric():
    import logging

    from app.core.http import RedactingFilter
    rec = logging.LogRecord("t", logging.INFO, "", 0, "%s %s %.0fms", ("GET", "/x/9876543210", 84.123456), None)
    RedactingFilter().filter(rec)
    msg = rec.getMessage()                       # must not raise
    assert "9876543210" not in msg and msg.endswith("84ms")


def test_search_terms_are_safe_and_sensible():
    from app.modules.onboarding import search_terms
    assert search_terms(None) == {"idt": None, "nm": None, "ph": None}
    assert search_terms("   ") == {"idt": None, "nm": None, "ph": None}
    assert search_terms("  arun   stores ")["nm"] == "%arun stores%"                  # spaces trimmed and collapsed
    assert search_terms("a_b%")["idt"] == "%a\\_b\\%%"                              # % and _ are literal, not wildcards
    short = search_terms("1")
    assert short["ph"] is None and short["nm"] is None and short["idt"] == "%1%"    # short numbers: shop number only
    phone = search_terms("+91 98840-38398")
    assert phone["ph"] == "%919884038398%" and phone["nm"] is None                  # long numbers: phone search
    assert search_terms("D-01")["nm"] == "%D-01%"                                   # shop numbers with a dash still match names too


def test_renter_is_reminded_every_day_once_overdue_and_owner_5_days_before():
    due = date(2026, 11, 5)
    assert overdue_days(date(2026, 11, 5), due, 500, True) is None                 # on the due date: not late yet
    assert [overdue_days(date(2026, 11, d), due, 500, True) for d in (6, 7, 20)] == [1, 2, 15]   # every late day
    assert overdue_days(date(2026, 11, 8), due, 0, True) is None                  # paid: stop
    assert overdue_days(date(2026, 11, 8), due, 500, False) is None               # closed tenancy: stop
    assert owner_notice(date(2026, 10, 31), due, 500, True) == ("soon", 5)        # owner: 5 days before
    assert owner_notice(date(2026, 11, 1), due, 500, True) is None
    assert owner_notice(date(2026, 11, 6), due, 500, True) == ("late", 1)         # first late day, then weekly
    assert owner_notice(date(2026, 11, 7), due, 500, True) is None
    assert owner_notice(date(2026, 11, 13), due, 500, True) == ("late", 8)
    assert owner_notice(date(2026, 10, 31), due, 0, True) is None
