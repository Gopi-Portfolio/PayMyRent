// Beyond "every language has the same keys" (translations.test.ts): nothing is left in English, every text the code asks for exists, and no screen carries
// English of its own that no language file could translate.
import * as nodefs from 'fs';
import * as nodepath from 'path';

import { fs, path } from '../test-support/files';

const LOCALES = ['hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn'];
const dir = nodepath.join(__dirname, '../src/i18n/locales');
const load = (l: string) => JSON.parse(nodefs.readFileSync(nodepath.join(dir, `${l}.json`), 'utf8'));
const flat = (o: any, p = ''): Record<string, string> =>
  Object.entries(o).reduce((a, [k, v]) => (typeof v === 'object' && v ? { ...a, ...flat(v, `${p}${k}.`) } : { ...a, [`${p}${k}`]: String(v) }), {} as Record<string, string>);
const en = flat(load('en'));
const sources = fs.walk(['app', 'src'], /\.tsx?$/).filter((f) => !f.includes('/i18n/'));

// names and terms that are the same in every language
const SAME = /RentMeezy|PAN|OTP|UPI|AI|SMS|WhatsApp|Excel|PDF|CSV|Google Pay|PhonePe|Paytm|GST|DD-MM-YYYY|\.xlsx|IFSC|Aadhaar|KYC|NEFT|IMPS|ID|URL|OK|MB|GB/g;

test('no text is left in English in any other language', () => {
  const left: string[] = [];
  for (const l of LOCALES) {
    for (const [k, v] of Object.entries(flat(load(l)))) {
      const text = v.replace(/\{\{[^}]*\}\}/g, '').replace(SAME, '');
      if (/[A-Za-z]{3,}(\s+[A-Za-z]{2,}){2,}/.test(text) || (v === en[k] && /[a-z]{4}/.test(text))) left.push(`${l}  ${k} = ${v.slice(0, 60)}`);
    }
  }
  expect(left).toEqual([]);
});

test('every text the code asks for with t(\'...\') exists', () => {
  const missing = new Set<string>();
  for (const f of sources) {
    for (const m of fs.read(f).matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      const k = m[1];
      if (k.endsWith('.')) continue;
      if (!(k in en) && !(`${k}_one` in en) && !(`${k}_other` in en)) missing.add(`${k}  (${path.rel(f)})`);
    }
  }
  expect([...missing]).toEqual([]);
});

test('every singular text has its plural, in every language', () => {
  for (const l of ['en', ...LOCALES]) {
    const keys = Object.keys(flat(load(l)));
    expect(keys.filter((k) => k.endsWith('_one') && !keys.includes(k.replace(/_one$/, '_other')))).toEqual([]);
  }
});

test('no screen has English of its own in a label a screen reader or a button reads out', () => {
  const bad: string[] = [];
  for (const f of sources) {
    fs.read(f).split('\n').forEach((line, i) => {
      if (/(accessibilityLabel|label|title|placeholder)="[A-Z][a-z]+( [A-Za-z]+)*"/.test(line) && !/Google Pay|PhonePe|Paytm|Approve \(Demo|"OTP"|"RentMeezy"/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
        bad.push(`${path.rel(f)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  expect(bad).toEqual([]);
});

test('the old wording is gone: renter, unit and property are the three words, and the retired launch-price texts do not remain', () => {
  const old = Object.entries(en).filter(([k, v]) => /\btenants?\b/i.test(v) || /\bplaces?\b/i.test(v.replace(/\{\{[^}]*\}\}/g, '')) && !/in one place|everywhere/i.test(v) || /launch price|plan full/i.test(v));
  expect(old.map(([k, v]) => `${k} = ${v.slice(0, 60)}`)).toEqual([]);
});
