import { sanitize } from './inputs';

describe('input guards', () => {
  it('mobile keeps 10 digits and strips a pasted +91 / 0 prefix', () => {
    expect(sanitize('mobile', '98765 43210')).toBe('9876543210');
    expect(sanitize('mobile', '+91 98765 43210')).toBe('9876543210');
    expect(sanitize('mobile', '098765 43210')).toBe('9876543210');
    expect(sanitize('mobile', 'abc12345678901234')).toBe('1234567890');
  });
  it('otp is 6 digits', () => { expect(sanitize('otp', '12a34 56789')).toBe('123456'); });
  it('amount allows one dot and two decimals', () => {
    expect(sanitize('amount', '12.345')).toBe('12.34');
    expect(sanitize('amount', '1.2.3')).toBe('1.23');
    expect(sanitize('amount', 'abc-5')).toBe('5');
    expect(sanitize('amount', '1234567890123')).toBe('123456789');
  });
  it('day is at most 2 digits', () => { expect(sanitize('day', '123')).toBe('12'); });
  it('name allows letters in any script but no digits', () => {
    expect(sanitize('name', 'Ravi 123 Kumar')).toBe('Ravi Kumar');
    expect(sanitize('name', 'கோபிநாத் ர')).toBe('கோபிநாத் ர');
  });
  it('pan is uppercase alphanumeric, 10 chars', () => { expect(sanitize('pan', 'abcde-1234f99')).toBe('ABCDE1234F'); });
  it('date and month are typed as digits with dashes added (Indian order)', () => {
    expect(sanitize('date', '05112026')).toBe('05-11-2026');
    expect(sanitize('date', '0511')).toBe('05-11');
    expect(sanitize('date', '05-11-2026999')).toBe('05-11-2026');
    expect(sanitize('month', '112026')).toBe('11-2026');
    expect(sanitize('month', '1')).toBe('1');
  });
  it('email has no spaces', () => { expect(sanitize('email', ' A@B.com ')).toBe('a@b.com'); });
});
