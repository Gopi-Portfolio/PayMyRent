// Input guards: what a field accepts is limited AS THE USER TYPES (or pastes), so bad values never get into the form.
// The server re-validates everything; these are the first line of defence and a better experience.
export type InputKind =
  | 'mobile' | 'otp' | 'amount' | 'reading' | 'day' | 'name' | 'pan' | 'email' | 'month' | 'date'
  | 'unit' | 'place' | 'percent' | 'address' | 'reason' | 'text';

const LIMITS: Record<InputKind, number> = {
  mobile: 10, otp: 6, amount: 12, reading: 12, day: 2, name: 60, pan: 10, email: 100, month: 7, date: 10,
  unit: 20, place: 80, percent: 6, address: 250, reason: 100, text: 100,
};

export const maxLengthFor = (kind: InputKind) => LIMITS[kind];

/** A box with no kind and no limit of its own still has one: 100 characters on one line, 500 in a text area. Nothing accepts unlimited text. */
export const DEFAULT_MAX = { line: 100, area: 500 };

/** The fewest characters a typed value may have (an empty optional box is fine; a started one must reach this). Boxes that are exactly one length are the phone, code, PAN and dates. */
const MINS: Partial<Record<InputKind, number>> = {
  mobile: 10, otp: 6, pan: 10, month: 7, date: 10, name: 2, address: 5, email: 6, day: 1,      // (name and address match the server's own minimums)
};
export const minLengthFor = (kind: InputKind): number | undefined => MINS[kind];

/** Keep at most one "." and at most `dp` digits after it. */
function decimal(s: string, dp: number, intDigits: number) {
  const cleaned = s.replace(/[^\d.]/g, '');
  const [i, ...rest] = cleaned.split('.');
  const head = i.slice(0, intDigits);
  return rest.length ? `${head}.${rest.join('').slice(0, dp)}` : head;
}

export function sanitize(kind: InputKind, input: string): string {
  const max = LIMITS[kind];
  switch (kind) {
    case 'mobile': {
      let d = input.replace(/\D/g, '');
      if (d.length > 10 && d.startsWith('91')) d = d.slice(2);   // pasted +91 number
      if (d.length > 10 && d.startsWith('0')) d = d.slice(1);    // pasted 0-prefixed number
      return d.slice(0, 10);
    }
    case 'otp': return input.replace(/\D/g, '').slice(0, 6);
    case 'day': return input.replace(/\D/g, '').slice(0, 2);
    case 'amount': return decimal(input, 2, 9);                    // up to 9 digits and 2 decimals (₹ 99,99,99,999.99)
    case 'reading': return decimal(input, 3, 8);
    case 'percent': return decimal(input, 2, 3);                    // 0 to 100, two decimals
    case 'name': return input.replace(/[^\p{L}\p{M}\s.'-]/gu, '').replace(/\s{2,}/g, ' ').slice(0, max);
    case 'pan': return input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    case 'email': return input.replace(/\s/g, '').toLowerCase().slice(0, max);
    // typed as digits; the dashes are added for you: MM-YYYY and DD-MM-YYYY
    case 'month': { const d = input.replace(/\D/g, '').slice(0, 6); return d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d; }
    case 'date': { const d = input.replace(/\D/g, '').slice(0, 8); return d.length > 4 ? `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}-${d.slice(2)}` : d; }
    // a commercial place is described, not numbered: "10-50 hostel", "2 shops, 5 houses", "Factory shed"
    case 'place': return input.replace(/[^\p{L}\p{M}\p{N}\s\-/#.,&+()']/gu, '').slice(0, max);
    case 'unit': return input.replace(/[^\p{L}\p{M}\p{N}\s\-/#.]/gu, '').slice(0, max);
    default: return input.slice(0, max);                            // address, reason, text
  }
}

const KEYBOARD: Partial<Record<InputKind, 'number-pad' | 'decimal-pad' | 'phone-pad' | 'email-address'>> = {
  mobile: 'phone-pad', otp: 'number-pad', day: 'number-pad', amount: 'decimal-pad', reading: 'decimal-pad', percent: 'decimal-pad', email: 'email-address',
};
export const keyboardFor = (kind: InputKind) => KEYBOARD[kind];
