// The floor of a building as a dropdown: None, Ground, 1st ... 10th. The list opens in place (no pop-up), so every row is a plain tap.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { FLOORS, floorLabel } from '@/lib/units';
import { brand, radius } from '@/theme';

export function FloorSelect({ value, onChange }: { value: number | null; onChange: (n: number | null) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const name = (n: number | null) => (n === null ? t('tenancy.floorNone') : floorLabel(n, t, i18n.language));
  const pick = (n: number | null) => { setOpen(false); onChange(n); };
  return (
    <View style={{ gap: 6 }} testID="floor-picker">
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="floor-dropdown"
                 accessibilityLabel={`${t('tenancy.floor')}: ${name(value)}`}
                 style={{ height: 58, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1.5, borderColor: open ? brand.teal700 : brand.line }}>
        <Text variant="labelSmall" style={{ color: brand.muted }}>{t('tenancy.floor')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '700', color: brand.ink }}>{name(value)}</Text>
          <Icon source={open ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden', maxHeight: 264 }}>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {[null, ...FLOORS].map((n) => {
              const on = value === n;
              return (
                <Pressable key={String(n)} onPress={() => pick(n)} accessibilityRole="button" accessibilityState={{ selected: on }} testID={`floor-${n ?? 'none'}`}
                           style={({ pressed }) => ({ height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: on || pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
                  <Icon source={on ? 'check-circle' : 'stairs'} size={20} color={brand.teal700} />
                  <Text numberOfLines={1} style={{ flex: 1, fontWeight: on ? '800' : '600', color: brand.ink }}>{name(n)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
