// A search bar with a filter button INSIDE it, on the right (a small dot on the button shows that a filter is on).
import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { brand, radius } from '@/theme';

export function SearchBox({ value, onChangeText, placeholder, onFilter, filterActive, filterEnabled = true, disabled, filterLabel, testID }: {
  value: string; onChangeText: (v: string) => void; placeholder: string; onFilter?: () => void; filterActive?: boolean; filterEnabled?: boolean;
  disabled?: boolean; filterLabel: string; testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', height: 46, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1.5, borderColor: brand.line,
                   paddingLeft: 12, opacity: disabled ? 0.5 : 1 }}>
      <Icon source="magnify" size={22} color={brand.muted} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={brand.faint} editable={!disabled} testID={testID}
                 returnKeyType="search" autoCorrect={false} accessibilityLabel={placeholder} style={{ flex: 1, height: 44, paddingHorizontal: 8, fontSize: 15, color: brand.ink }} />
      {value ? (
        <Pressable onPress={() => onChangeText('')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.clear')} style={{ paddingHorizontal: 6 }}>
          <Icon source="close-circle" size={18} color={brand.faint} />
        </Pressable>
      ) : null}
      <View style={{ width: 1, height: 24, backgroundColor: brand.line }} />
      <Pressable onPress={filterEnabled && !disabled ? onFilter : undefined} disabled={!filterEnabled || disabled} accessibilityRole="button" accessibilityLabel={filterLabel}
                 testID={testID ? `${testID}-filter` : undefined} style={{ width: 48, height: 44, alignItems: 'center', justifyContent: 'center', opacity: filterEnabled ? 1 : 0.35 }}>
        <Icon source="tune-variant" size={22} color={filterActive ? brand.teal700 : brand.muted} />
        {filterActive ? <View style={{ position: 'absolute', top: 9, right: 11, width: 9, height: 9, borderRadius: 5, backgroundColor: brand.teal700, borderWidth: 1.5, borderColor: '#fff' }} /> : null}
      </Pressable>
    </View>
  );
}
