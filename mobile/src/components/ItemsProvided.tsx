// What the owner provides with the place, as the owner typed it (commas, semicolons or new lines), shown as a tidy list.
import React from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Panel } from '@/components/ui';
import { brand, radius } from '@/theme';

export const splitItems = (raw: string | null | undefined): string[] => (raw ?? '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

export function ItemsProvided({ text }: { text?: string | null }) {
  const { t } = useTranslation();
  const items = splitItems(text);
  if (items.length === 0) return null;
  return (
    <Panel tone="teal" icon="package-variant-closed" title={t('tenancy.itemsProvided')}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} testID="items-provided">
        {items.map((x, i) => (
          <View key={`${i}-${x}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: brand.teal50, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Icon source="check" size={14} color={brand.teal700} />
            <Text style={{ fontWeight: '600' }}>{x}</Text>
          </View>
        ))}
      </View>
    </Panel>
  );
}
