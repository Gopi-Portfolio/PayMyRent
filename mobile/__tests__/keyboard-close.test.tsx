// Every text box carries the tick that closes the keyboard while it is typed in: text, number, phone pad and multi-line alike.
// Boxes made with the shared Field get it from Field itself; this checks the ones that are written out by hand (the search bar has its own, tested in search-box-done.test.tsx).
import { fs, path } from '../test-support/files';

/** The text of a JSX element from its opening `<` to its own closing `/>`, skipping any `/>` inside `{ ... }`. */
function element(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length - 1; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    else if (depth === 0 && src[i] === '/' && src[i + 1] === '>') return src.slice(start, i + 2);
  }
  return src.slice(start, start + 600);
}

test('every hand-written text box has the tick that closes the keyboard', () => {
  const missing: string[] = [];
  let checked = 0;
  for (const file of fs.walk(['app', 'src'], /\.tsx$/)) {
    if (path.rel(file).endsWith('src/components/ui.tsx')) continue;                       // Field itself, tested in keyboard-dismiss.test.tsx
    if (path.rel(file).endsWith('src/components/SearchBox.tsx')) continue;                // the search bar, tested in search-box-done.test.tsx
    const src = fs.read(file);
    for (const m of src.matchAll(/<TextInput\b(?!\.)/g)) {
      const el = element(src, m.index!);
      if (/editable=\{false\}/.test(el)) continue;                                        // nothing can be typed in it
      checked++;
      if (!/\{\.\.\.\w*[dD]one\w*\}|icon="check-circle"/.test(el)) missing.push(`${path.rel(file)}:${src.slice(0, m.index!).split('\n').length}`);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(9);                                              // the scan really found the boxes
  expect(missing).toEqual([]);
});

test('every hand-written text box that is not multi-line or a pad closes with the keyboard\'s own Done / Search key', () => {
  const bad: string[] = [];
  for (const file of fs.walk(['app', 'src'], /\.tsx$/)) {
    if (path.rel(file).endsWith('src/components/ui.tsx')) continue;
    const src = fs.read(file);
    for (const m of src.matchAll(/<TextInput\b(?!\.)/g)) {
      const el = element(src, m.index!);
      if (/editable=\{false\}|\bmultiline\b|number-pad|decimal-pad|phone-pad/.test(el)) continue;
      if (!/returnKeyType=/.test(el)) bad.push(`${path.rel(file)}:${src.slice(0, m.index!).split('\n').length}`);
    }
  }
  expect(bad).toEqual([]);
});
