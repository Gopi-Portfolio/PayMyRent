// React Native refuses to draw a bare string (even spaces) that sits directly inside a View: "Text strings must be rendered within a <Text> component".
// The test renderer is more forgiving, so these two checks stand in for the phone's rule.
import { fs, path } from '../test-support/files';

test('no source file has a JSX element followed on the same line by spaces and then a { } block (that makes a stray text string)', () => {
  const bad: string[] = [];
  for (const file of fs.walk(['app', 'src'], /\.tsx$/)) {
    fs.read(file).split('\n').forEach((line, i) => {
      if (/(\/>|<\/[A-Za-z.]+>)[ ]+\{/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${path.rel(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  expect(bad).toEqual([]);
});

test('no source file has an opening View/Pressable tag followed on the same line by spaces and then a { } block, e.g. a comment (that makes a stray text string)', () => {
  const bad: string[] = [];
  for (const file of fs.walk(['app', 'src'], /\.tsx$/)) {
    fs.read(file).split('\n').forEach((line, i) => {
      if (/<(View|Pressable|LinearGradient|ScrollView)\b(?:(?!<Text)[^\n])*?(\}\}|")>[ ]+\{/.test(line) && !/^\s*(\/\/|\*)/.test(line)) bad.push(`${path.rel(file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  expect(bad).toEqual([]);
});
