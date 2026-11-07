export const NOTE_MAX = 250;

// Pure helpers mirrored from api/app/domain (validation.py, money.py). No dependencies, unit-tested.
const VIRAMAS = new Set(['\u094d', '\u09cd', '\u0a4d', '\u0acd', '\u0b4d', '\u0bcd', '\u0c4d', '\u0ccd', '\u0d4d']);
const MARK = /\p{M}/u;
const LETTER = /\p{L}/u;

/** User-perceived characters. Uses Intl.Segmenter when the JS engine has it, else the same
 *  Indic-aware fallback as the server (marks, virama conjuncts, ZWJ, flags, skin tones). */
export function graphemeCount(s: string): number {
  const Seg = (Intl as any).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s)).length;
  let count = 0; let prev = ''; let riOpen = false;
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0)!;
    let joins = MARK.test(ch) || ch === '\u200d' || ch === '\u200c' || (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) || (VIRAMAS.has(prev) && LETTER.test(ch)) || prev === '\u200d';
    const isRI = cp >= 0x1f1e6 && cp <= 0x1f1ff;
    if (isRI && riOpen) { joins = true; riOpen = false; } else riOpen = isRI;
    if (!joins || count === 0) count += 1;
    prev = ch;
  }
  return count;
}

export function normalizeMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

export function parseRupeesToPaise(raw: string): number | null {
  const t = raw.replace(/[₹,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [r, p = ''] = t.split('.');
  return Number(r) * 100 + Number((p + '00').slice(0, 2));
}

/** The most one amount box accepts: the server's own ceiling, Rs 1,00,00,000. */
export const MAX_ENTRY_PAISE = 1_000_000_000;

export function formatINR(paise: number): string {
  const neg = paise < 0; const abs = Math.abs(paise);
  const r = Math.floor(abs / 100); const p = abs % 100;
  const s = r.toString();
  const grouped = s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3) : s;
  return `${neg ? '-' : ''}₹${grouped}${p ? '.' + p.toString().padStart(2, '0') : ''}`;
}

/** What is typed in an amount box, held at the due amount: typing more than is due leaves the due amount in the box.
 *  Returns the text to show and whether it had to be held back. */
export function capToDue(text: string, duePaise: number): { text: string; capped: boolean } {
  const p = parseRupeesToPaise(text);
  const due = Math.max(0, duePaise);
  if (p === null || p <= due) return { text, capped: false };
  return { text: due % 100 === 0 ? String(due / 100) : (due / 100).toFixed(2), capped: true };
}

/** What can be paid right now for a rental: this month and earlier. A balance that was moved to next month is owed, but not payable yet. */
export const payNow = (r: any): number => Math.max(Number(r?.payable_now_paise ?? r?.balance_paise ?? 0), 0);
