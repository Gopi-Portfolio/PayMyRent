// Who the second owner is to the primary owner. Required whenever a second owner's number is entered.
import React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { brand, radius } from '@/theme';

export const RELATIONSHIPS = ['brother', 'sister', 'parent', 'son', 'daughter', 'friend', 'family'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export function RelationshipPicker({ value, onChange }: { value: Relationship | null; onChange: (r: Relationship) => void }) {
  const { t } = useTranslation();
  return (
    <View style={{ gap: 6 }}>
      <Text variant="labelLarge" style={{ color: brand.muted }}>{t('ownerNumbers.relationship')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {RELATIONSHIPS.map((r) => {
          const on = value === r;
          return (
            <Pressable key={r} onPress={() => onChange(r)} accessibilityRole="radio" accessibilityState={{ selected: on }} testID={`rel-${r}`}
                       style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, backgroundColor: on ? brand.teal700 : brand.teal50, borderColor: on ? brand.teal700 : brand.teal100 }}>
              <Text style={{ color: on ? '#fff' : brand.teal700, fontWeight: '800', fontSize: 13 }}>{t(`ownerNumbers.rel_${r}`)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
