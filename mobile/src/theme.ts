// RentMeezy design tokens: deep teal brand, warm amber accent, soft neutral canvas, generous radii.
import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

// The brand colours come in two sets. The owner's is deep teal; the renter's is the blue of the renter's top bar. `brand.teal*` and
// `brand.canvas` read whichever set is current, so signing in as a renter turns the whole window blue without touching each screen.
const PALETTES = {
  owner: { teal900: '#064E45', teal700: '#0B6E5F', teal600: '#0F8A77', teal100: '#D7F2EB', teal50: '#EDF9F6', canvas: '#F4F7F6', soft: '#B6E6DA', surfaceVariant: '#EAF1EF' },
  tenant: { teal900: '#1E3A8A', teal700: '#1D4ED8', teal600: '#2563EB', teal100: '#DBEAFE', teal50: '#EFF6FF', canvas: '#EEF3FD', soft: '#BFD3FA', surfaceVariant: '#E4ECFB' },
} as const;
export type RoleName = keyof typeof PALETTES;
let current: (typeof PALETTES)[RoleName] = PALETTES.owner;
/** Called once per render of the app shell with the role in use. */
export function setBrandRole(role: RoleName): void { current = PALETTES[role]; }

export const brand = {
  get teal900() { return current.teal900; },
  get teal700() { return current.teal700; },
  get teal600() { return current.teal600; },
  get teal100() { return current.teal100; },
  get teal50() { return current.teal50; },
  get canvas() { return current.canvas; },
  get tealSoft() { return current.soft; },
  amber500: '#F59E0B',
  amber100: '#FEF3C7',
  red600: '#DC2626',
  red100: '#FEE2E2',
  green600: '#16A34A',
  green100: '#DCFCE7',
  blue600: '#2563EB',
  blue100: '#DBEAFE',
  ink: '#0F1F1C',
  muted: '#5B6B67',
  line: '#E3EAE8',
  faint: '#8A9A96',        // inactive icons and tab labels
  disabled: '#9AA9A5',     // text and icons of something locked or switched off
  disabledBg: '#EEF2F1',   // the box behind a locked or switched-off control
};

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 };

export const shadow = {
  shadowColor: '#0B2A25', shadowOpacity: 0.08, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3,
} as const;

function buildLight(role: RoleName) {
  const p = PALETTES[role];
  return {
  ...MD3LightTheme,
  roundness: 3,
  colors: {
    ...MD3LightTheme.colors,
    primary: p.teal700,
    onPrimary: '#FFFFFF',
    primaryContainer: p.teal100,
    onPrimaryContainer: p.teal900,
    secondary: brand.amber500,
    secondaryContainer: brand.amber100,
    onSecondaryContainer: '#6B4500',
    tertiary: brand.blue600,
    background: p.canvas,
    surface: '#FFFFFF',
    surfaceVariant: p.surfaceVariant,
    onSurface: brand.ink,
    onSurfaceVariant: brand.muted,
    outline: '#C5D2CE',
    outlineVariant: brand.line,
    error: brand.red600,
    elevation: { ...MD3LightTheme.colors.elevation, level1: '#FFFFFF', level2: '#FFFFFF', level3: '#FFFFFF' },
  },
  };
}

export const lightTheme = buildLight('owner');
export const renterTheme = buildLight('tenant');
/** The Paper theme for the role in use. */
export const themeFor = (role: RoleName) => (role === 'tenant' ? renterTheme : lightTheme);

export const darkTheme = {
  ...MD3DarkTheme,
  roundness: 3,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#5ED1B5',
    onPrimary: '#00382F',
    primaryContainer: '#0B4A40',
    onPrimaryContainer: '#C9F5EA',
    secondary: '#FBBF24',
    background: '#0B1513',
    surface: '#13211E',
    surfaceVariant: '#1B2D29',
    onSurface: '#E6F1EE',
    onSurfaceVariant: '#9DB2AD',
    outline: '#38504A',
    outlineVariant: '#25382F',
  },
};

/** One accent per landlord, so a tenant with several owners can tell them apart at a glance. */
export const OWNER_COLORS = [
  { fg: '#0B6E5F', bg: '#D7F2EB' }, { fg: '#2563EB', bg: '#DBEAFE' }, { fg: '#B45309', bg: '#FEF3C7' },
  { fg: '#7C3AED', bg: '#EDE9FE' }, { fg: '#BE185D', bg: '#FCE7F3' }, { fg: '#0E7490', bg: '#CFFAFE' },
];
