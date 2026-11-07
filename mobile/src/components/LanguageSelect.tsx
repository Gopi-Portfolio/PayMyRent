// A language as a dropdown that opens in place (no pop-up): the language's own name, e.g. தமிழ், हिन्दी, తెలుగు.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';

import { LANGUAGES } from '@/i18n';
import { brand, radius } from '@/theme';

export const languageName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.label ?? code;

export function LanguageSelect({ label, value, onChange, testID }: { label: string; value: string; onChange: (code: string) => void; testID: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`${testID}-box`} accessibilityLabel={`${label}: ${languageName(value)}`}
                 style={{ height: 58, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1.5, borderColor: open ? brand.teal700 : brand.line }}>
        <Text variant="labelSmall" style={{ color: brand.muted }}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '800', color: brand.ink, fontSize: 16 }}>{languageName(value)}</Text>
          <Icon source={open ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden' }}>
          {LANGUAGES.map((l) => {
            const on = l.code === value;
            return (
              <Pressable key={l.code} onPress={() => { setOpen(false); onChange(l.code); }} accessibilityRole="button" accessibilityState={{ selected: on }} testID={`${testID}-${l.code}`}
                         style={({ pressed }) => ({ height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: on || pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
                <Icon source={on ? 'check-circle' : 'translate'} size={20} color={brand.teal700} />
                <Text style={{ flex: 1, fontWeight: on ? '800' : '600', color: brand.ink }}>{l.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
