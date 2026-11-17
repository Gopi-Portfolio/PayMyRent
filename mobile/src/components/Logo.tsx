// RentMeezy logo. The artwork is a picture (assets/brand): the emblem (house, the woman with the phone, the green swoosh) and the full logo with its name.
// On the teal and blue headers the emblem sits on a small white tile, and the full logo on a white card, so the picture's white background never shows.
import React from 'react';
import { Image, View } from 'react-native';
import { Text } from 'react-native-paper';

import { brand, radius } from '@/theme';

const WHITE = require('../../assets/brand/logo-white.png');     // 2172 x 724, white on transparent: for the coloured headers
const WHITE_RATIO = 2172 / 724;
const FULL = require('../../assets/brand/logo-full.png');       // 2172 x 724
const FULL_RATIO = 2172 / 724;

export const BRAND_NAME = 'RentMeezy';

/** Kept so existing callers still compile: the logo no longer animates. */
export function playLogoIntro() { /* nothing to play */ }

/** The small logo in every screen's top bar: the white logo on the coloured header. */
export function RentMeezyBarLogo({ height = 44 }: { height?: number; light?: boolean }) {
  return <Image source={WHITE} accessibilityLabel={BRAND_NAME} style={{ width: Math.round(height * WHITE_RATIO), height }} resizeMode="contain" />;
}

/** The white logo for the sign-in pages' coloured header. `width` is the picture's width. */
export function LogoWhite({ width = 220 }: { width?: number }) {
  return <Image source={WHITE} accessibilityLabel={BRAND_NAME} style={{ width, height: Math.round(width / WHITE_RATIO) }} resizeMode="contain" />;
}

/** The full logo (emblem, name and tagline) on a white card: the landing page and the login pages. `size` is roughly the old logo height. */
export function Logo({ size = 44, light = false, bare = false }: { size?: number; light?: boolean; stacked?: boolean; bare?: boolean }) {
  const width = Math.round(size * 4.6);
  // bare: no white card, for a page whose background is already light (the landing page)
  if (bare) return <Image source={FULL} accessibilityLabel={BRAND_NAME} style={{ width, height: Math.round(width / FULL_RATIO) }} resizeMode="contain" />;
  return (
    <View accessibilityLabel={BRAND_NAME} accessibilityRole="image"
          style={{ backgroundColor: '#fff', borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center',
                   ...(light ? { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 } : {}) }}>
      <Image source={FULL} style={{ width, height: Math.round(width / FULL_RATIO) }} resizeMode="contain" />
    </View>
  );
}
