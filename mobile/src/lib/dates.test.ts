import { dmyToIso, fmtDate, fmtMonth, myToYm } from './dates';

describe('Indian dates', () => {
  it('formats ISO as DD-MM-YYYY and months as Mon YYYY', () => {
    expect(fmtDate('2026-11-05')).toBe('05-11-2026');
    expect(fmtMonth('2026-11-01')).toBe('Nov 2026');
  });
  it('parses DD-MM-YYYY only when it is a real date', () => {
    expect(dmyToIso('05-11-2026')).toBe('2026-11-05');
    expect(dmyToIso('31-02-2026')).toBeNull();
    expect(dmyToIso('2026-11-05')).toBeNull();
  });
  it('parses MM-YYYY', () => { expect(myToYm('11-2026')).toBe('2026-11'); expect(myToYm('13-2026')).toBeNull(); });
});
