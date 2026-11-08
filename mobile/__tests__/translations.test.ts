import * as fs from 'fs';
import * as path from 'path';

const LOCALES = ['en', 'ta', 'hi', 'te', 'kn', 'ml', 'mr', 'bn'];
const dir = path.join(__dirname, '../src/i18n/locales');
const load = (l: string) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const flat = (o: any, p = ''): Record<string, string> =>
  Object.entries(o).reduce((a, [k, v]) => (typeof v === 'object' && v ? { ...a, ...flat(v, `${p}${k}.`) } : { ...a, [`${p}${k}`]: String(v) }), {} as Record<string, string>);
const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');

test('every language has exactly the same texts as English, with the same {{placeholders}}', () => {
  const en = flat(load('en'));
  for (const l of LOCALES.slice(1)) {
    const other = flat(load(l));
    expect(Object.keys(en).filter((k) => !(k in other))).toEqual([]);                         // nothing missing
    expect(Object.keys(other).filter((k) => !(k in en))).toEqual([]);                         // nothing extra
    expect(Object.keys(en).filter((k) => placeholders(en[k]) !== placeholders(other[k]))).toEqual([]);   // {{owner}}, {{count}} ... kept
  }
});

test('no text in the app falls back to an English default: every t(key, { defaultValue }) key is in all languages', () => {
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p);
  });
  ['../app', '../src'].forEach((d) => walk(path.join(__dirname, d)));
  const re = /\bt\(\s*'([\w.]+)'\s*,\s*\{\s*defaultValue:/g;
  const used = new Set<string>();
  files.forEach((f) => { const s = fs.readFileSync(f, 'utf8'); let m; while ((m = re.exec(s))) used.add(m[1]); });
  const langs = Object.fromEntries(LOCALES.map((l) => [l, flat(load(l))]));
  const has = (l: string, k: string) => k in langs[l] || `${k}_other` in langs[l];
  const missing = [...used].flatMap((k) => LOCALES.filter((l) => !has(l, k)).map((l) => `${l}:${k}`));
  expect(missing).toEqual([]);
});
