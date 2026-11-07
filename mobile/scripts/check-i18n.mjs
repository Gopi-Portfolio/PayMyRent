// Fails if any locale is missing a key that English has (critical flows must never show raw keys).
import fs from 'node:fs';
const dir = new URL('../src/i18n/locales/', import.meta.url);
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, p + k + '.') : [p + k]));
const en = new Set(flat(JSON.parse(fs.readFileSync(new URL('en.json', dir)))));
let bad = 0;
for (const f of fs.readdirSync(dir)) {
  const keys = new Set(flat(JSON.parse(fs.readFileSync(new URL(f, dir)))));
  const missing = [...en].filter((k) => !keys.has(k));
  const empty = flat(JSON.parse(fs.readFileSync(new URL(f, dir)))).length !== keys.size;
  if (missing.length || empty) { bad++; console.error(f, 'missing', missing); }
}
console.log(bad ? `${bad} locale(s) incomplete` : `all ${fs.readdirSync(dir).length} locales complete (${en.size} keys)`);
process.exit(bad ? 1 : 0);
