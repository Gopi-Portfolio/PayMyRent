// A short note at the top of a screen whose job cannot be done without the internet (recording a payment, adding a property, import, the AI, paying):
// shown only while offline, so the person knows at once that this one cannot be saved for later and why, instead of finding out from an error.
import React from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { useOnline } from '@/lib/network';

export function NeedsInternet() {
  const { t } = useTranslation();
  const online = useOnline();
  if (online) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#FEF3C7', borderRadius: 14, padding: 12 }} testID="needs-internet" accessibilityLiveRegion="polite">
      <Icon source="cloud-off-outline" size={22} color="#7C4A03" />
      <Text style={{ flex: 1, color: '#7C4A03', fontWeight: '700', lineHeight: 20 }}>{t('offline.needsInternet')}</Text>
    </View>
  );
}
