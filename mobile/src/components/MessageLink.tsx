// A one-line link to the "Message renter" screen: speak or type, translate, send. Optionally for one rental.
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { brand, radius, shadow } from '@/theme';

export function MessageLink({ tenancyId }: { tenancyId?: string }) {
  const { t } = useTranslation();
  return (
    <Pressable onPress={() => router.push(tenancyId ? `/(app)/owner/message?tenancyId=${tenancyId}` : '/(app)/owner/message')} accessibilityRole="button" testID="message-link"
               style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: radius.md, padding: 12, borderLeftWidth: 4, borderLeftColor: brand.blue600 }, shadow, pressed && { backgroundColor: brand.teal50 }]}>
      <Icon source="message-text-outline" size={22} color={brand.blue600} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: '800' }}>{t('message.linkTitle')}</Text>
        <Text variant="bodySmall" style={{ color: brand.muted }}>{t('message.linkSub')}</Text>
      </View>
      <Icon source="chevron-right" size={20} color={brand.muted} />
    </Pressable>
  );
}
