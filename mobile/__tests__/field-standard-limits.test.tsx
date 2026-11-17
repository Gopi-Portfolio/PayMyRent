import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { PaperProvider } from 'react-native-paper';

import { Field } from '@/components/ui';
import { maxLengthFor, minLengthFor, sanitize, DEFAULT_MAX } from '@/lib/inputs';
import { fs, path } from '../test-support/files';
import '@/i18n';

const wrap = (ui: React.ReactElement) => <PaperProvider>{ui}</PaperProvider>;
const box = (props: any, id = 'f') => { const ui = render(wrap(<Field label="X" value="" onChangeText={() => {}} testID={id} {...props} />)); return { ui, input: ui.getByTestId(id) }; };

describe('standard maximum lengths', () => {
  test('a box with no kind and no limit still has one: 100 on a line, 500 in a text area', () => {
    expect(box({}).input.props.maxLength).toBe(DEFAULT_MAX.line);
    expect(box({ multiline: true }).input.props.maxLength).toBe(DEFAULT_MAX.area);
    expect(DEFAULT_MAX).toEqual({ line: 100, area: 500 });
  });
  test.each([['mobile', 10], ['otp', 6], ['pan', 10], ['day', 2], ['name', 60], ['email', 100], ['address', 250], ['unit', 20], ['place', 80], ['reason', 100], ['text', 100]] as const)(
    'a %s box takes at most %i characters', (kind, max) => {
      expect(maxLengthFor(kind)).toBe(max);
      expect(box({ kind }).input.props.maxLength).toBe(max);
    });
  test('a limit given on the box wins (pincode 6, document number 40, city 80)', () => {
    expect(box({ kind: 'text', maxLength: 6 }).input.props.maxLength).toBe(6);
    expect(box({ kind: 'text', maxLength: 80 }).input.props.maxLength).toBe(80);
  });
  test('a phone number never goes past 10 digits, however it is typed or pasted', () => {
    expect(sanitize('mobile', '98765432101234')).toBe('9876543210');
    expect(sanitize('mobile', '+91 98765 43210')).toBe('9876543210');
    expect(sanitize('mobile', '09876543210')).toBe('9876543210');
    expect(sanitize('mobile', 'abc98x76')).toBe('9876');
    expect(sanitize('otp', '12345678')).toBe('123456');
    expect(sanitize('pan', 'abcde12345fzz')).toBe('ABCDE12345');
  });
  test('text and text-area kinds cut what is typed or pasted to their limit', () => {
    expect(sanitize('name', 'A'.repeat(200)).length).toBe(60);
    expect(sanitize('address', 'A'.repeat(400)).length).toBe(250);
    expect(sanitize('text', 'A'.repeat(400)).length).toBe(100);
    expect(sanitize('email', 'a'.repeat(300) + '@x.in').length).toBe(100);
  });
});

describe('standard minimum lengths', () => {
  const left = (props: any, text: string) => {
    const { ui, input } = box(props);
    fireEvent(input, 'focus'); fireEvent.changeText(input, text); fireEvent(input, 'blur');
    return ui;
  };
  test('the minimums match the server: name 2, address 5, mobile 10, code 6, PAN 10', () => {
    expect([minLengthFor('name'), minLengthFor('address'), minLengthFor('mobile'), minLengthFor('otp'), minLengthFor('pan')]).toEqual([2, 5, 10, 6, 10]);
  });
  test('short values show the message after the box is left', () => {
    const Controlled = ({ kind, start }: { kind: any; start: string }) => { const [v, setV] = React.useState(start); return <Field label="X" value={v} onChangeText={setV} testID="f" kind={kind} />; };
    const a = render(wrap(<Controlled kind="mobile" start="98765" />));
    fireEvent(a.getByTestId('f'), 'blur');
    expect(a.getByText('Enter exactly 10 digits')).toBeTruthy();
    const b = render(wrap(<Controlled kind="name" start="A" />));
    fireEvent(b.getByTestId('f'), 'blur');
    expect(b.getByText('Enter at least 2 characters')).toBeTruthy();
    const c = render(wrap(<Controlled kind="address" start="abc" />));
    fireEvent(c.getByTestId('f'), 'blur');
    expect(c.getByText('Enter at least 5 characters')).toBeTruthy();
  });
  test('an empty optional box and a long enough value show no message; the screen\'s own error comes first', () => {
    const Controlled = ({ kind, start, error }: { kind: any; start: string; error?: string }) => { const [v, setV] = React.useState(start); return <Field label="X" value={v} onChangeText={setV} testID="f" kind={kind} error={error} />; };
    for (const [kind, start] of [['mobile', ''], ['mobile', '9876543210'], ['name', 'Ravi']] as const) {
      const ui = render(wrap(<Controlled kind={kind} start={start} />));
      fireEvent(ui.getByTestId('f'), 'blur');
      expect(ui.queryByTestId('field-short')).toBeNull();
    }
    const own = render(wrap(<Controlled kind="mobile" start="98765" error="Enter your phone" />));
    fireEvent(own.getByTestId('f'), 'blur');
    expect(own.queryByTestId('field-short')).toBeNull();
  });
  test('a box can set its own minimum (pincode: exactly 6 digits)', () => {
    const Pin = () => { const [v, setV] = React.useState('625'); return <Field label="Pincode" value={v} onChangeText={setV} testID="pin" kind="text" keyboardType="number-pad" maxLength={6} minLength={6} />; };
    const ui = render(wrap(<Pin />));
    fireEvent(ui.getByTestId('pin'), 'blur');
    expect(ui.getByText('Enter exactly 6 digits')).toBeTruthy();
  });
});

test('every hand-written text box has a maximum length', () => {
  const missing: string[] = [];
  for (const file of fs.walk(['app', 'src'], /\.tsx$/)) {
    if (/src\/components\/(ui|SearchBox)\.tsx$/.test(path.rel(file))) continue;      // Field (default limits) and the search bar
    const src = fs.read(file);
    for (const m of src.matchAll(/<TextInput\b(?!\.)/g)) {
      let depth = 0, end = m.index! + 600;
      for (let i = m.index!; i < src.length - 1; i++) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; else if (depth === 0 && c === '/' && src[i + 1] === '>') { end = i + 2; break; } }
      const el = src.slice(m.index!, end);
      if (/editable=\{false\}/.test(el)) continue;
      if (!/maxLength=/.test(el)) missing.push(`${path.rel(file)}:${src.slice(0, m.index!).split('\n').length}`);
    }
  }
  expect(missing).toEqual([]);
});
