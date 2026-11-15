// RentMeezy logo. The artwork is a picture (assets/brand): the emblem (house, the woman with the phone, the green swoosh) and the full logo with its name.
// On the teal and blue headers the emblem sits on a small white tile, and the full logo on a white card, so the picture's white background never shows.
import React from 'react';
import { Image, View } from 'react-native';
import { Text } from 'react-native-paper';

import { brand } from '@/theme';

const MARK = require('../../assets/brand/logo-mark.png');       // 504 x 521
const FULL = require('../../assets/brand/logo-full.png');       // 1161 x 529
const FULL_RATIO = 1161 / 529;

export const BRAND_NAME = 'RentMeezy';

/** Kept so existing callers still compile: the logo no longer animates. */
export function playLogoIntro() { /* nothing to play */ }

/** The small logo in every screen's top bar: the emblem on a white tile, and the name beside it. */
export function RentMeezyBarLogo({ height = 44, light = true }: { height?: number; light?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }} accessibilityLabel={BRAND_NAME} accessibilityRole="image">
      <View style={{ width: height, height, borderRadius: height * 0.28, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Image source={MARK} style={{ width: height * 0.9, height: height * 0.9 }} resizeMode="contain" />
      </View>
      <Text style={{ color: light ? '#fff' : brand.ink, fontWeight: '800', fontSize: Math.round(height * 0.42), letterSpacing: 0.2 }}>{BRAND_NAME}</Text>
    </View>
  );
}

/** The full logo (emblem, name and tagline) on a white card: the landing page and the login pages. `size` is roughly the old logo height. */
export function Logo({ size = 44, light = false }: { size?: number; light?: boolean; stacked?: boolean }) {
  const width = Math.round(size * 4.6);
  return (
    <View accessibilityLabel={BRAND_NAME} accessibilityRole="image"
          style={{ backgroundColor: '#fff', borderRadius: 22, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center',
                   ...(light ? { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 6 } : {}) }}>
      <Image source={FULL} style={{ width, height: Math.round(width / FULL_RATIO) }} resizeMode="contain" />
    </View>
  );
}
