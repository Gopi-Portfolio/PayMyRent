// Help: plain-language guide to every part of PayMyRent. Reachable from the header menu, signed in or onboarding.
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Screen } from '@/components/ui';
import { brand, radius, shadow } from '@/theme';

const TOPICS = [
  { k: 'start', icon: 'rocket-launch-outline', bg: brand.teal100, fg: brand.teal700 },
  { k: 'places', icon: 'home-city-outline', bg: brand.teal100, fg: brand.teal700 },
  { k: 'bills', icon: 'file-document-outline', bg: brand.teal100, fg: brand.teal700 },
  { k: 'pay', icon: 'cash-fast', bg: brand.amber100, fg: '#B45309' },
  { k: 'upi', icon: 'cellphone-check', bg: brand.green100, fg: brand.green600 },
  { k: 'relief', icon: 'hand-heart-outline', bg: brand.amber100, fg: '#B45309' },
  { k: 'vacate', icon: 'door-open', bg: brand.red100, fg: brand.red600 },
  { k: 'agree', icon: 'file-sign', bg: brand.blue100, fg: brand.blue600 },
  { k: 'notify', icon: 'bell-outline', bg: brand.blue100, fg: brand.blue600 },
  { k: 'message', icon: 'message-text-outline', bg: brand.green100, fg: brand.green600 },
  { k: 'download', icon: 'download-outline', bg: brand.teal100, fg: brand.teal700 },
  { k: 'remind', icon: 'bell-ring-outline', bg: brand.blue100, fg: brand.blue600 },
  { k: 'pricing', icon: 'tag-outline', bg: brand.amber100, fg: '#B45309' },
  { k: 'verify', icon: 'shield-check-outline', bg: brand.green100, fg: brand.green600 },
  { k: 'roles', icon: 'swap-horizontal', bg: brand.blue100, fg: brand.blue600 },
  { k: 'ai', icon: 'creation', bg: brand.teal100, fg: brand.teal700 },
  { k: 'account', icon: 'account-cog-outline', bg: brand.teal100, fg: brand.teal700 },
  { k: 'more', icon: 'lifebuoy', bg: brand.red100, fg: brand.red600 },
] as const;

export default function Help() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState<string | null>('start');
  return (
    <Screen>
      <Text variant="bodyMedium" style={{ color: brand.muted }}>{t('help.intro')}</Text>
      {TOPICS.map((x) => {
        const on = open === x.k;
        return (
          <View key={x.k} style={[{ backgroundColor: '#fff', borderRadius: radius.md, overflow: 'hidden' }, shadow]}>
            <Pressable onPress={() => setOpen(on ? null : x.k)} accessibilityRole="button" accessibilityState={{ expanded: on }} testID={`help-${x.k}`}
                       style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: pressed ? brand.canvas : '#fff' })}>
              <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: x.bg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon source={x.icon} size={22} color={x.fg} />
              </View>
              <Text variant="titleSmall" style={{ flex: 1, fontWeight: '800' }}>{t(`help.s_${x.k}`)}</Text>
              <Icon source={on ? 'chevron-up' : 'chevron-down'} size={22} color={brand.muted} />
            </Pressable>
            {on ? <Text variant="bodyMedium" style={{ paddingHorizontal: 14, paddingBottom: 16, lineHeight: 22 }}>{t(`help.b_${x.k}`)}</Text> : null}
          </View>
        );
      })}
    </Screen>
  );
}
