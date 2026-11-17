// One way to show what kind a place is, on every screen: a round R on blue for residential, a round C on orange for commercial.
// (A property that has both shows R/C on the app colour.) Screen readers read the full name.
import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { kindGroup } from '@/lib/units';
import { brand } from '@/theme';

export const KIND_COLORS = { residential: brand.blue600, commercial: '#F97316', mixed: brand.teal700 } as const;

export function KindBadge({ kind, size = 28, testID }: { kind: string | null | undefined; size?: number; testID?: string }) {
  const { t } = useTranslation();
  const group = kind === 'mixed' ? 'mixed' : kindGroup(kind);
  const letter = group === 'residential' ? 'R' : group === 'commercial' ? 'C' : 'R/C';
  const name = group === 'mixed' ? t('property.mixed') : t(`tenancy.kind_${group}`);
  const wide = group === 'mixed';
  return (
    <View accessible accessibilityLabel={name} testID={testID}
          style={{ minWidth: size, height: size, borderRadius: size / 2, paddingHorizontal: wide ? size * 0.28 : 0, backgroundColor: KIND_COLORS[group], alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontWeight: '800', fontSize: Math.round(size * (wide ? 0.4 : 0.5)), color: '#fff', lineHeight: Math.round(size * 0.62) }}>{letter}</Text>
    </View>
  );
}
