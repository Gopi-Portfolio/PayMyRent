"""Text matching for the automatic document check: OCR output is noisy, so matching is loose but still has to refuse wrong people."""
from __future__ import annotations

from datetime import date

from app.domain import docmatch as m


def test_pan_is_found_even_with_the_usual_ocr_confusions():
    assert m.find_pan("Permanent Account Number\nABCPE1234F\nName") == "ABCPE1234F"
    assert m.find_pan("A8CPE 1234 F") == "ABCPE1234F"              # 8 read for B, spaces inside
    assert m.find_pan("ABCPE123OF") == "ABCPE1230F"                # O read for a digit
    assert m.find_pan("AB0PE1234F") == "ABOPE1234F"                # 0 read for a letter
    assert m.find_pan("hello world, no number here") is None
    assert m.find_pan("ABCDE1234F") is None                          # 4th letter D is not a PAN holder type: a made-up PAN
    assert m.find_pan("ABCZE1234F") is None


def test_name_matching_is_loose_about_order_noise_and_initials_but_not_about_other_people():
    text = "Name\nRAMESH KUMAR SHARMA\nFather's Name\nSURESH SHARMA"
    region = m.pan_name_region(text)
    assert m.name_in_text("Ramesh Kumar Sharma", region)
    assert m.name_in_text("Sharma Ramesh Kumar", region)             # any order
    assert m.name_in_text("Ramesh K. Sharma", region)                # an initial is ignored
    assert m.name_in_text("RAMESH KUMAR SHARNA", region)             # one OCR slip
    assert not m.name_in_text("Suresh Sharma", region)               # the father's name, which sits below the cut
    assert not m.name_in_text("Meena Devi", region)
    assert not m.name_in_text("", region)


def test_a_shared_surname_alone_is_not_enough():
    assert not m.name_in_text("Anil Kumar Sharma", "RAMESH KUMAR SHARMA")


def test_name_similarity_ignores_word_order_and_case():
    assert m.name_similarity("Ramesh Kumar", "KUMAR RAMESH") > 0.95
    assert m.name_similarity("Ramesh Kumar", "Meena Devi") < 0.5


def test_address_is_found_by_pincode_or_by_most_of_its_words():
    deed = "property situated at 12 Market Road, Anna Nagar, Madurai - 625 020 bounded on the north by"
    assert m.address_in_text("12 Market Rd, Anna Nagar", "625020", deed)             # pincode written with a space
    assert m.address_in_text("12 Market Road Anna Nagar", None, deed)               # words
    assert not m.address_in_text("77 Elsewhere Lane, Teppakulam", "625009", deed)


def test_birth_date_and_age():
    assert m.find_birth_date("Date of Birth\n12/05/1980") == date(1980, 5, 12)
    assert m.find_birth_date("31/02/1980") is None
    assert m.age_on(date(2010, 11, 15), date(2026, 11, 14)) == 15
    assert m.age_on(date(2008, 11, 14), date(2026, 11, 14)) == 18


def test_enough_text_rejects_blank_or_wrong_photos():
    assert not m.enough_text("  \n ")
    assert not m.enough_text("page 1 of 2")
    assert m.enough_text(" ".join(["word"] * 40))


def test_aadhaar_check_digit_and_number_finding():
    base = "23456789012"
    number = base + m.verhoeff_check_digit(base)
    assert m.verhoeff_valid(number) and not m.verhoeff_valid(number[:-1] + str((int(number[-1]) + 1) % 10))
    text = f"Government of India\nRamesh\nDOB: 12/05/1980\n{number[:4]} {number[4:8]} {number[8:]}\nVID 9876 5432 1098 7654"
    assert m.find_aadhaar(text) == number
    assert m.find_aadhaar("1234 5678 9012") is None                    # starts with 1, and the check digit is wrong
    assert m.find_aadhaar("2345 6789 0123") is None                    # wrong check digit: a made-up number
    masked = m.mask_aadhaar_text(text, number)
    assert number[:8] not in masked.replace(" ", "") and m.aadhaar_last4(masked) == number[8:]
    assert "98765432" not in masked.replace(" ", "") and "XXXX XXXX XXXX 7654" in masked           # the VID is hidden too


def test_aadhaar_name_region_and_year_of_birth():
    t = "Government of India\nRAMESH KUMAR SHARMA\nYear of Birth: 1980\nMale"
    assert m.name_in_text("Ramesh Kumar Sharma", m.aadhaar_name_region(t))
    assert m.find_birth_date_or_year(t) == date(1980, 12, 31)
    assert m.find_birth_date_or_year("DOB: 01/02/1990") == date(1990, 2, 1)
