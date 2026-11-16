"""Reading a renter's name and mobile number from OCR text. The text below is how real photos read: noisy, with the card's own printing mixed in."""
from app.domain.renter_scan import extract_renter_details, find_mobile, find_name

AADHAAR_FRONT = """Government of India
Ravi Kumar
DOB: 12/03/1990
Male
4821 5530 7196
VID : 9187 4455 6012 3344
"""
PAN_CARD = """INCOME TAX DEPARTMENT
GOVT. OF INDIA
Permanent Account Number
ABCPK1234F
Name
SELVI MURUGAN
Father's Name
MURUGAN S
Date of Birth
05/07/1985
"""
AGREEMENT = """RENTAL AGREEMENT
This agreement is made on 01-11-2026 between Mr. Anand Raj S/o Late Raj, residing at 12 Market Road, Madurai (hereinafter called the Lessor)
and Mrs. Kavya Iyer W/o Mr. Suresh, mobile 98765 43210 (hereinafter called the Tenant). The monthly rent is Rs. 12000.
"""
VISITING_CARD = """Eswar Mobiles
Sales & Service
Eswar Prasad
+91 90000 00025
www.eswarmobiles.example
"""
LABELLED = """Tenant Details
Name : Imran Khan
Mobile No: 09123456780
Address: 5 Lake View, Chennai
"""


def test_a_labelled_name_and_a_mobile_number_are_found():
    assert extract_renter_details(LABELLED) == {"name": "IMRAN KHAN", "mobile": "9123456780"}


def test_an_aadhaar_front_gives_the_name_and_never_the_number_as_a_mobile():
    out = extract_renter_details(AADHAAR_FRONT)
    assert out == {"name": "RAVI KUMAR", "mobile": None}                    # 4821 5530 7196 and the VID are not mobile numbers
    assert "4821" not in str(out) and "7196" not in str(out)


def test_a_pan_card_gives_the_holder_not_the_fathers_name_or_the_card_wording():
    assert find_name(PAN_CARD) == "SELVI MURUGAN"


def test_in_a_rent_agreement_the_name_is_the_tenant_not_the_landlord():
    out = extract_renter_details(AGREEMENT)
    assert out == {"name": "KAVYA IYER", "mobile": "9876543210"}             # not Anand Raj (the Lessor); the 5+5 written number is read


def test_a_visiting_card_with_a_country_code():
    out = extract_renter_details(VISITING_CARD)
    assert out["mobile"] == "9000000025"
    assert out["name"] == "ESWAR PRASAD"


def test_numbers_are_read_however_they_are_written():
    for text in ("9876543210", "+91 9876543210", "+91-98765-43210", "091 9876543210", "Ph: 98765 43210.", "98765-43210"):
        assert find_mobile(text) == "9876543210", text


def test_things_that_are_not_mobile_numbers_are_ignored():
    for text in ("1234567890", "5876543210", "Rs. 98765432100", "098765432", "4821 5530 7196", "2026-11-05", "PIN 625001"):
        assert find_mobile(text) is None, text


def test_the_first_mobile_number_wins():
    assert find_mobile("Alt 9111111111, main 9222222222") == "9111111111"


def test_no_name_is_invented_from_the_printing_on_a_card():
    for text in ("Government of India\nUnique Identification Authority of India\nMale\n12/03/1990", "RENTAL AGREEMENT\nMonthly Rent\nSecurity Deposit", "Permanent Account Number"):
        assert find_name(text) is None, text


def test_a_name_is_cut_before_s_o_brackets_digits_and_commas():
    assert find_name("Name: Ravi Kumar S/o Raman") == "RAVI KUMAR"
    assert find_name("Name: Ravi Kumar (Tenant)") == "RAVI KUMAR"
    assert find_name("Name: Ravi Kumar, 12 Main Road") == "RAVI KUMAR"
    assert find_name("Name: Ravi Kumar 1990") == "RAVI KUMAR"


def test_empty_noisy_or_missing_text_gives_nothing_and_does_not_fail():
    for text in ("", "   \n  ", "~~~ ### !!!", None):
        assert extract_renter_details(text) == {"name": None, "mobile": None}  # type: ignore[arg-type]


def test_a_single_letter_or_a_stray_word_is_not_a_name():
    for text in ("Name: R", "Name: .", "Name: -", "R K"):
        assert find_name(text) is None, text
