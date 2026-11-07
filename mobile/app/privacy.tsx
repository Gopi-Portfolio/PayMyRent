// Plain-language privacy notice (what we keep, why, who sees it, and the person's rights).
import React from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Screen } from '@/components/ui';
import { brand, radius } from '@/theme';

const ITEMS = [['collect', 'database-outline'], ['use', 'cog-outline'], ['share', 'account-eye-outline'], ['keep', 'archive-lock-outline'], ['rights', 'shield-account-outline']] as const;

export default function Privacy() {
  const { t } = useTranslation();
  return (
    <Screen>
      {ITEMS.map(([k, icon]) => (
        <View key={k} style={{ flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: brand.line }}>
          <Icon source={icon} size={26} color={brand.teal700} />
          <Text style={{ flex: 1, lineHeight: 22 }}>{t(`privacy.${k}`)}</Text>
        </View>
      ))}
    </Screen>
  );
}
