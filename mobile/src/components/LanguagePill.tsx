// A visible language choice for screens that have no menu yet (the landing page and sign-in): a small pill showing the language in its own
// script, and a list that opens right under it (no pop-up). Picking one changes the whole app at once and is remembered on the phone.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { LANGUAGES } from '@/i18n';
import { saveLanguage } from '@/lib/language';
import { brand, radius, shadow } from '@/theme';

export function LanguagePill({ top }: { top: number }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = LANGUAGES.find((l) => l.code === i18n.language) ?? LANGUAGES[0];
  const choose = (code: string) => { setOpen(false); i18n.changeLanguage(code); saveLanguage(code); };
  return (
    <View style={{ position: 'absolute', right: 16, top, zIndex: 50, elevation: 50, alignItems: 'flex-end' }} pointerEvents="box-none">
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="language-pill"
                 accessibilityLabel={`${t('help.menuLanguage')}: ${current.label}`} hitSlop={8}
                 style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 12, borderRadius: radius.pill,
                                            backgroundColor: pressed ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.22)' })}>
        <Icon source="translate" size={18} color="#fff" />
        <Text style={{ color: '#fff', fontWeight: '800' }}>{current.label}</Text>
        <Icon source={open ? 'menu-up' : 'menu-down'} size={20} color="#fff" />
      </Pressable>
      {open ? (
        <View style={[{ marginTop: 8, minWidth: 190, backgroundColor: '#fff', borderRadius: radius.md, overflow: 'hidden' }, shadow]} testID="language-list">
          {LANGUAGES.map((l) => {
            const on = l.code === i18n.language;
            return (
              <Pressable key={l.code} onPress={() => choose(l.code)} accessibilityRole="menuitem" accessibilityState={{ selected: on }} testID={`landing-lang-${l.code}`}
                         style={({ pressed }) => ({ height: 46, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: on || pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
                <Icon source={on ? 'check-circle' : 'translate'} size={20} color={brand.teal700} />
                <Text style={{ flex: 1, fontWeight: on ? '800' : '600', color: brand.ink, fontSize: 16 }}>{l.label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
