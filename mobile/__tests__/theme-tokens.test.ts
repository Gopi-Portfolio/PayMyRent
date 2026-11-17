import fs from 'fs';
import path from 'path';

// Colours that have a name in the theme are used by name on every screen, so one change in theme.ts changes them everywhere.
const NAMED: Record<string, string> = {
  '#B45309': 'brand.amber700', '#5B6B67': 'brand.muted', '#003472': 'brand.blue600', '#1F8A02': 'brand.green600',
  '#DCE8F7': 'brand.blue100', '#FEF3C7': 'brand.amber100', '#FEE2E2': 'brand.red100',
};
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : [];
});
const root = path.join(__dirname, '..');
const files = [...walk(path.join(root, 'app')), ...walk(path.join(root, 'src', 'components'))];

test('screens and components use the theme names for named colours, not the hex values', () => {
  const found: string[] = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const [hex, name] of Object.entries(NAMED)) if (new RegExp(`['"]${hex}['"]`, 'i').test(s)) found.push(`${path.relative(root, f)} uses ${hex}: write ${name}`);
  }
  expect(found).toEqual([]);
});

test('the corner sizes that have a name (10, 16, 22, pill) are used by name', () => {
  const found: string[] = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    if (/borderRadius:\s*(10|16|22|999)\b(?!\.)/.test(s)) found.push(path.relative(root, f));
  }
  expect(found).toEqual([]);
});
