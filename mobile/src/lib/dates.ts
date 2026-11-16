// Indian date convention: day, month, year (DD-MM-YYYY); months as MM-YYYY. The API always gets ISO (YYYY-MM-DD / YYYY-MM-01).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-11-05 -> 05-11-2026 */
export function fmtDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
/** 2026-11-01 -> Nov 2026 */
export function fmtMonth(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : '';
}
export const todayDMY = () => fmtDate(new Date().toISOString().slice(0, 10));

/** 05-11-2026 -> 2026-11-05 (null if not a real calendar date) */
export function dmyToIso(s: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d ? `${y}-${mo}-${d}` : null;
}
/** 11-2026 -> 2026-11 (null if invalid) */
export function myToYm(s: string): string | null {
  const m = /^(\d{2})-(\d{4})$/.exec(s);
  return m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 2000 ? `${m[2]}-${m[1]}` : null;
}

/** Last day of the month of an ISO date, as ISO. 2026-11-01 -> 2026-11-30 */
export function monthEndIso(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return '';
  const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}
