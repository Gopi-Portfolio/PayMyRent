"""Localized HTML receipts and statements (printable; PDF via WeasyPrint when installed).
Labels below are first-draft translations pending native-speaker review."""
from __future__ import annotations

from html import escape
from uuid import UUID

from ..core.db import Db
from ..domain.money import format_inr

LABELS = {
    "statement": {"en": "Rent statement", "ta": "வாடகை அறிக்கை", "hi": "किराया विवरण", "te": "అద్దె స్టేట్‌మెంట్",
                  "kn": "ಬಾಡಿಗೆ ಹೇಳಿಕೆ", "ml": "വാടക സ്റ്റേറ്റ്മെന്റ്", "mr": "भाडे विवरण", "bn": "ভাড়ার বিবরণী"},
    "receipt": {"en": "Receipt", "ta": "ரசீது", "hi": "रसीद", "te": "రసీదు", "kn": "ರಸೀದಿ", "ml": "രസീത്", "mr": "पावती", "bn": "রসিদ"},
    "month": {"en": "Month", "ta": "மாதம்", "hi": "महीना", "te": "నెల", "kn": "ತಿಂಗಳು", "ml": "മാസം", "mr": "महिना", "bn": "মাস"},
    "billed": {"en": "Billed", "ta": "கட்டணம்", "hi": "बिल राशि", "te": "బిల్లు", "kn": "ಬಿಲ್", "ml": "ബിൽ", "mr": "बिल", "bn": "বিল"},
    "open": {"en": "Unpaid", "ta": "செலுத்தாதது", "hi": "बकाया", "te": "చెల్లించనిది", "kn": "ಬಾಕಿ", "ml": "കുടിശ്ശിക", "mr": "थकबाकी", "bn": "বকেয়া"},
    "total_due": {"en": "Total due", "ta": "மொத்த நிலுவை", "hi": "कुल देय", "te": "మొత్తం బాకీ", "kn": "ಒಟ್ಟು ಬಾಕಿ",
                  "ml": "ആകെ കുടിശ്ശിക", "mr": "एकूण देय", "bn": "মোট বকেয়া"},
    "deposit": {"en": "Security deposit held", "ta": "வைப்புத்தொகை", "hi": "सुरक्षा जमा", "te": "సెక్యూరిటీ డిపాజిట్",
                "kn": "ಭದ್ರತಾ ಠೇವಣಿ", "ml": "സെക്യൂരിറ്റി ഡെപ്പോസിറ്റ്", "mr": "सुरक्षा ठेव", "bn": "জামানত"},
    "owner_recorded": {"en": "Cash — recorded by owner (not gateway-verified)", "ta": "ரொக்கம் — உரிமையாளர் பதிவு",
                       "hi": "नकद — मालिक द्वारा दर्ज", "te": "నగదు — యజమాని నమోదు", "kn": "ನಗದು — ಮಾಲೀಕರ ದಾಖಲೆ",
                       "ml": "പണം — ഉടമ രേഖപ്പെടുത്തിയത്", "mr": "रोख — मालकाने नोंदवले", "bn": "নগদ — মালিক নথিভুক্ত"},
    "gateway_verified": {"en": "Online — verified by payment gateway", "ta": "ஆன்லைன் — கேட்வே சரிபார்த்தது",
                         "hi": "ऑनलाइन — गेटवे द्वारा सत्यापित", "te": "ఆన్‌లైన్ — గేట్‌వే ధృవీకరించింది", "kn": "ಆನ್‌ಲೈನ್ — ಗೇಟ್‌ವೇ ದೃಢೀಕರಿಸಿದೆ",
                         "ml": "ഓൺലൈൻ — ഗേറ്റ്‌വേ സ്ഥിരീകരിച്ചു", "mr": "ऑनलाइन — गेटवेने पडताळले", "bn": "অনলাইন — গেটওয়ে যাচাইকৃত"},
}


def L(key: str, lang: str) -> str:
    return LABELS[key].get(lang) or LABELS[key]["en"]


_CSS = """body{font-family:'Noto Sans','Noto Sans Tamil','Noto Sans Devanagari','Noto Sans Telugu','Noto Sans Kannada',
'Noto Sans Malayalam','Noto Sans Bengali',system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#111}
table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid #ddd;text-align:left}
.r{text-align:right}.demo{background:#fde68a;padding:6px 10px;font-weight:600}"""


def render_statement(db: Db, tenancy_id: UUID, lang: str) -> str:
    head = db.one("""SELECT u.identifier, p.name, p.address, o.display_name, s.name AS tenant, b.balance_paise, b.deposit_held_paise
                     FROM tenancies t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
                     JOIN owner_accounts o ON o.id = t.owner_account_id JOIN v_tenancy_balance b ON b.tenancy_id = t.id
                     LEFT JOIN LATERAL (SELECT name FROM tenancy_contact_snapshots WHERE tenancy_id = t.id ORDER BY created_at DESC LIMIT 1) s ON true
                     WHERE t.id = :t""", t=tenancy_id)
    months = db.all("SELECT period_month, number, total_paise, open_paise FROM v_invoice_status WHERE tenancy_id = :t ORDER BY period_month", t=tenancy_id)
    rows = "".join(f"<tr><td>{m['period_month']:%b %Y}</td><td>{escape(m['number'])}</td><td class=r>{format_inr(m['total_paise'])}</td>"
                   f"<td class=r>{format_inr(m['open_paise'])}</td></tr>" for m in months)
    return f"""<!doctype html><html lang="{lang}"><meta charset="utf-8"><title>{L('statement', lang)}</title><style>{_CSS}</style>
<h1>{L('statement', lang)}</h1><p><b>{escape(head['identifier'])}</b> · {escape(head['name'] or '')} · {escape(head['address'])}<br>
{escape(head['display_name'])} → {escape(head['tenant'] or '')}</p>
<table><tr><th>{L('month', lang)}</th><th>#</th><th class=r>{L('billed', lang)}</th><th class=r>{L('open', lang)}</th></tr>{rows}</table>
<h2>{L('total_due', lang)}: {format_inr(head['balance_paise'])}</h2><p>{L('deposit', lang)}: {format_inr(head['deposit_held_paise'])}</p></html>"""


def render_receipt(db: Db, receipt_id: UUID, lang: str) -> str:
    r = db.one("""SELECT r.*, p.method, p.verification, p.paid_on, p.is_demo, o.display_name FROM receipts r
                  LEFT JOIN payments p ON p.id = r.payment_id JOIN owner_accounts o ON o.id = r.owner_account_id WHERE r.id = :r""", r=receipt_id)
    allocs = db.all("""SELECT i.period_month, l.category, sum(a.amount_paise) AS amt FROM payment_allocations a
                       JOIN invoice_lines l ON l.id = a.invoice_line_id JOIN monthly_invoices i ON i.id = l.invoice_id
                       WHERE a.payment_id = :p GROUP BY 1, 2 HAVING sum(a.amount_paise) <> 0 ORDER BY 1, 2""", p=r["payment_id"]) if r["payment_id"] else []
    how = L(r["verification"], lang) if r["verification"] in ("owner_recorded", "gateway_verified") else (r["verification"] or "")
    lines = "".join(f"<tr><td>{a['period_month']:%b %Y}</td><td>{a['category']}</td><td class=r>{format_inr(a['amt'])}</td></tr>" for a in allocs)
    demo = "<div class=demo>DEMO — not a real payment</div>" if r["is_demo"] else ""
    return f"""<!doctype html><html lang="{lang}"><meta charset="utf-8"><title>{escape(r['number'])}</title><style>{_CSS}</style>{demo}
<h1>{L('receipt', lang)} {escape(r['number'])}</h1><p>{escape(r['display_name'])} · {escape(r['unit_label'] or '')}<br>{escape(r['tenant_name'] or '')}</p>
<h2>{format_inr(r['amount_paise'])}</h2><p>{escape(how)} · {r['paid_on'] or r['issued_at']:%d-%m-%Y}</p><table>{lines}</table></html>"""
