// small helpers for tests that read the source tree
import * as nodefs from 'fs';
import * as nodepath from 'path';

const root = nodepath.resolve(__dirname, '..');
export const path = { rel: (f: string) => nodepath.relative(root, f) };
export const fs = {
  read: (f: string) => nodefs.readFileSync(f, 'utf8'),
  walk: (dirs: string[], pattern: RegExp): string[] => {
    const out: string[] = [];
    const visit = (d: string) => {
      for (const e of nodefs.readdirSync(d, { withFileTypes: true })) {
        const full = nodepath.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') visit(full); } else if (pattern.test(e.name)) out.push(full);
      }
    };
    dirs.forEach((d) => visit(nodepath.join(root, d)));
    return out;
  },
};
