// A one-line link to the agreement page: "Agreement ends 31-12-2026 · View". Turns amber when it ends within 30 days, red once it has ended.
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtDate } from '@/lib/dates';
import { brand, radius, shadow } from '@/theme';

export function AgreementLink({ tenancyId, endDate }: { tenancyId: string; endDate?: string | null }) {
  const { t } = useTranslation();
  const days = endDate ? Math.round((new Date(`${endDate}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86400000) : null;
  const lapsed = days !== null && days < 0;
  const soon = days !== null && days >= 0 && days <= 30;
  const color = lapsed ? brand.red600 : soon ? brand.amber700 : brand.teal700;
  return (
    <Pressable onPress={() => router.push(`/agreement/${tenancyId}`)} accessibilityRole="button" testID="agreement-link"
               style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderLeftWidth: 4, borderLeftColor: color }, shadow, pressed && { backgroundColor: brand.teal50 }]}>
      <Icon source="file-sign" size={22} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: '800' }}>{t('agreement.title')}</Text>
        <Text variant="bodySmall" style={{ color }}>{endDate ? (lapsed ? t('agreement.linkLapsed', { date: fmtDate(endDate) }) : t('agreement.linkEnds', { date: fmtDate(endDate) })) : t('agreement.openText')}</Text>
      </View>
      <Icon source="chevron-right" size={20} color={brand.muted} />
    </Pressable>
  );
}
