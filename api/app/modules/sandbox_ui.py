"""Shared, mobile-friendly HTML for the demo-only sandbox pages (identity check, checkout). Never served outside demo mode."""
from __future__ import annotations

from html import escape

_CSS = """
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:#F4F7F6;color:#0F1F1C;-webkit-text-size-adjust:100%}
.hero{background:linear-gradient(135deg,#064E45,#0B6E5F 55%,#0F8A77);color:#fff;padding:28px 20px 56px;text-align:center}
.brand{display:inline-flex;align-items:center;gap:10px;font-size:26px;font-weight:800;letter-spacing:-.5px}.brand b{color:#FCD34D}
.pill{display:inline-block;margin-top:14px;background:#FEF3C7;color:#92400E;border-radius:999px;padding:6px 14px;font-size:12px;font-weight:800;letter-spacing:.4px}
.wrap{max-width:460px;margin:-36px auto 0;padding:0 16px 40px}
.card{background:#fff;border-radius:22px;padding:20px;box-shadow:0 8px 24px rgba(11,42,37,.10);margin-bottom:14px}
h1{font-size:22px;margin:0 0 6px}p{margin:6px 0;color:#5B6B67;line-height:1.5}.sub{font-size:14px}
.steps{display:grid;gap:12px;margin-top:14px}.step{display:flex;gap:12px;align-items:center;font-weight:600}
.ic{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:20px;flex:none}
.g{background:#DCFCE7}.a{background:#FEF3C7}.r{background:#FEE2E2}.t{background:#D7F2EB}.b{background:#DBEAFE}
.opt{display:block;width:100%;text-align:left;border:0;border-radius:18px;padding:14px 16px;margin-top:12px;font:inherit;cursor:pointer;
 display:flex;gap:14px;align-items:center;transition:transform .08s,filter .12s}
.opt:active{transform:scale(.98);filter:brightness(.93)}
.opt .tt{font-weight:800;font-size:17px}.opt .ds{font-size:13px;opacity:.85;margin-top:2px}
.ok{background:#16A34A;color:#fff}.warn{background:#F59E0B;color:#3B2300}.bad{background:#fff;color:#DC2626;border:2px solid #FECACA}
.big{width:112px;height:112px;border-radius:56px;margin:8px auto 14px;display:flex;align-items:center;justify-content:center;font-size:54px;color:#fff}
.center{text-align:center}.note{background:#EDF9F6;border-radius:14px;padding:12px 14px;font-size:14px;color:#064E45;margin-top:14px}
.amount{font-size:40px;font-weight:800;margin:4px 0}
"""

_LOGO = ('<svg width="40" height="40" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14A58D"/>'
         '<stop offset="1" stop-color="#064E45"/></linearGradient></defs><rect width="96" height="96" rx="26" fill="url(#g)" stroke="#fff" stroke-opacity=".25"/>'
         '<path d="M20 46 L48 22 L76 46" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
         '<path d="M28 44 V72 a4 4 0 0 0 4 4 H64 a4 4 0 0 0 4 -4 V44" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
         '<circle cx="48" cy="56" r="12.5" fill="#FBBF24"/></svg>')


def page(title: str, body: str, badge: str = "DEMO MODE · nothing real happens") -> str:
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(title)}</title><style>{_CSS}</style></head><body>'
            f'<div class="hero"><div class="brand">{_LOGO}<span>Rent<b>Go</b></span></div><div><span class="pill">{escape(badge)}</span></div></div>'
            f'<div class="wrap">{body}</div></body></html>')


def option(value: str, css: str, icon: str, title: str, desc: str) -> str:
    return (f'<button class="opt {css}" name="outcome" value="{escape(value)}"><span style="font-size:26px">{icon}</span>'
            f'<span><div class="tt">{escape(title)}</div><div class="ds">{escape(desc)}</div></span></button>')


def result(ok: bool, title: str, detail: str, hint: str = "Tap Done (or the close button) at the top of this window to return to RentMeezy.") -> str:
    color = "#16A34A" if ok else "#DC2626"
    return page(title, f'<div class="card center"><div class="big" style="background:{color}">{"✓" if ok else "✕"}</div>'
                       f'<h1>{escape(title)}</h1><p>{escape(detail)}</p><div class="note">{escape(hint)}</div></div>')
