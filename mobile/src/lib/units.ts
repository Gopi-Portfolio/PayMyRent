// Two kinds of place, and nothing else: Residential and Commercial. A shop is a commercial place; a house or flat is residential.
// Both have a floor, a door / shop / room number (or a description), rooms and so on. The server stores exactly these two kinds.
export type KindGroup = 'residential' | 'commercial';

/** Older names still map: house / flat -> residential; shop / office / other -> commercial. */
export const kindGroup = (kind: string | null | undefined): KindGroup => {
  const k = String(kind ?? 'commercial');
  return k === 'residential' || k === 'house' || k === 'flat' ? 'residential' : 'commercial';
};

export const KIND_ICON: Record<KindGroup, string> = { residential: 'home-variant-outline', commercial: 'office-building-outline' };
export const kindIcon = (kind: string | null | undefined): string => KIND_ICON[kindGroup(kind)];

/** The translation key for the name of each kind, and the key used for it in the server's totals (residential / commercial). */
export const KIND_GROUPS = [
  { group: 'residential' as const, total: 'residential', label: 'owner.residential' },
  { group: 'commercial' as const, total: 'commercial', label: 'owner.commercial' },
];

/** "Ground floor", "1st floor" ... "10th floor" (English); "Floor 3" style in the other languages. Nothing for a unit with no floor given. */
const ordinal = (n: number) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
export function floorLabel(n: number | null | undefined, t: (k: string, o?: any) => string, lang: string): string {
  if (n === null || n === undefined) return '';
  if (n === 0) return t('tenancy.ground');
  return lang.startsWith('en') ? `${ordinal(n)} floor` : t('tenancy.floorN', { n });
}
/** The short form used on the floor chips. */
export const floorChip = (n: number, t: (k: string) => string, lang: string): string => (n === 0 ? t('tenancy.groundShort') : lang.startsWith('en') ? ordinal(n) : String(n));
export const FLOORS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
