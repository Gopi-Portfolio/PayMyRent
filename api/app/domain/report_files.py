"""Excel and PDF files for reports and statements. Built on the server from the same rows the app shows,
so the file always matches the screen. Money is integer paise and is written as rupees with two decimals."""
from __future__ import annotations

import io
from datetime import date, datetime
from html import escape
from typing import Any, Sequence

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF = "application/pdf"

_CSS = """@page{size:A4;margin:14mm}body{font-family:'Noto Sans','Noto Sans Tamil','Noto Sans Devanagari','Noto Sans Telugu','Noto Sans Kannada',
'Noto Sans Malayalam','Noto Sans Bengali',sans-serif;color:#111;font-size:11px}h1{font-size:18px;margin:0 0 4px}.sub{color:#555;margin:0 0 12px}
table{width:100%;border-collapse:collapse}th{background:#0f766e;color:#fff;text-align:left;padding:6px}td{padding:6px;border-bottom:1px solid #ddd}
.r{text-align:right}.tot td{font-weight:700;border-top:2px solid #0f766e}h2{font-size:13px;margin:16px 0 6px}"""


def _safe(v: Any) -> Any:
    """A spreadsheet treats a leading = + - @ as a formula; keep names and notes as plain text."""
    return "'" + v if isinstance(v, str) and v[:1] in "=+-@" else v


def _cell(v: Any, money: bool) -> Any:
    if v is None:
        return ""
    if money:
        return int(v) / 100
    if isinstance(v, datetime):
        return v.strftime("%d-%m-%Y")
    if isinstance(v, date):
        return v.strftime("%d-%m-%Y")
    return _safe(v)


def _inr(paise: int) -> str:
    s = f"{abs(int(paise)) // 100:,}.{abs(int(paise)) % 100:02d}"
    return ("-" if int(paise) < 0 else "") + "₹" + s


def _text(v: Any, money: bool) -> str:
    if v is None:
        return ""
    if money:
        return _inr(v)
    if isinstance(v, (date, datetime)):
        return v.strftime("%d-%m-%Y")
    return str(v)


Table = dict  # {"name": str, "headers": [str], "money": [bool], "rows": [[...]], "total": (label, paise) | None}


def table(name: str, headers: Sequence[str], rows: Sequence[Sequence[Any]], money_cols: Sequence[int] = (), total: tuple[str, int] | None = None) -> Table:
    return {"name": name, "headers": list(headers), "money": [i in money_cols for i in range(len(headers))], "rows": [list(r) for r in rows], "total": total}


CSV = "text/csv; charset=utf-8"


def make_csv(title: str, subtitle: str, tables: Sequence[Table]) -> bytes:
    """One CSV file: each table is a titled block (name row, header row, data rows) separated by a blank line.
    Written with a byte-order mark so Excel opens Tamil, Hindi and other scripts correctly."""
    import csv
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([title])
    w.writerow([subtitle])
    for t in tables:
        w.writerow([])
        w.writerow([t["name"]])
        w.writerow(t["headers"])
        for row in t["rows"]:
            w.writerow([_cell(v, m) for v, m in zip(row, t["money"])])
        if t.get("total"):
            w.writerow([t["total"][0], _inr(t["total"][1])])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")


def make_xlsx(title: str, subtitle: str, tables: Sequence[Table]) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    head_fill = PatternFill("solid", fgColor="0F766E")
    for t in tables:
        ws = wb.create_sheet(title=t["name"][:31] or "Report")
        ws["A1"] = title
        ws["A1"].font = Font(bold=True, size=14)
        ws["A2"] = subtitle
        for c, h in enumerate(t["headers"], 1):
            cell = ws.cell(row=4, column=c, value=h)
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = head_fill
        for r, row in enumerate(t["rows"], 5):
            for c, v in enumerate(row, 1):
                cell = ws.cell(row=r, column=c, value=_cell(v, t["money"][c - 1]))
                if t["money"][c - 1]:
                    cell.number_format = '"₹"#,##0.00'
                    cell.alignment = Alignment(horizontal="right")
        end = 5 + len(t["rows"])
        if t["total"]:
            ws.cell(row=end, column=1, value=t["total"][0]).font = Font(bold=True)
            money_col = max([i for i, m in enumerate(t["money"], 1) if m] or [len(t["headers"])])
            cell = ws.cell(row=end, column=money_col, value=int(t["total"][1]) / 100)
            cell.font = Font(bold=True)
            cell.number_format = '"₹"#,##0.00'
        for c, h in enumerate(t["headers"], 1):
            width = max([len(str(h))] + [len(_text(r[c - 1], t["money"][c - 1])) for r in t["rows"] if c - 1 < len(r)])
            ws.column_dimensions[get_column_letter(c)].width = min(max(width + 3, 12), 48)
        ws.freeze_panes = "A5"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def make_pdf(title: str, subtitle: str, tables: Sequence[Table]) -> bytes:
    from weasyprint import HTML  # installed in the API image (needs Pango/HarfBuzz for Indian scripts)
    parts = [f"<h1>{escape(title)}</h1><p class=sub>{escape(subtitle)}</p>"]
    for t in tables:
        if len(tables) > 1:
            parts.append(f"<h2>{escape(t['name'])}</h2>")
        head = "".join(f"<th{' class=r' if m else ''}>{escape(h)}</th>" for h, m in zip(t["headers"], t["money"], strict=True))
        body = "".join("<tr>" + "".join(f"<td{' class=r' if t['money'][i] else ''}>{escape(_text(v, t['money'][i]))}</td>" for i, v in enumerate(r)) + "</tr>"
                       for r in t["rows"])
        if not t["rows"]:
            body = f"<tr><td colspan={len(t['headers'])}>—</td></tr>"
        total = ""
        if t["total"]:
            total = f"<tr class=tot><td colspan={max(len(t['headers']) - 1, 1)}>{escape(t['total'][0])}</td><td class=r>{escape(_inr(t['total'][1]))}</td></tr>"
        parts.append(f"<table><tr>{head}</tr>{body}{total}</table>")
    html = f"<!doctype html><html><meta charset=utf-8><title>{escape(title)}</title><style>{_CSS}</style>{''.join(parts)}</html>"
    return HTML(string=html).write_pdf()
