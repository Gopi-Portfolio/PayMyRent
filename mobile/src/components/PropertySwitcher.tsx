// The owner's properties as a dropdown: "Properties:" on the left, the selected property in the box, the full list underneath when opened.
// Each property is its own account with its own plan, so switching changes everything on the owner screens.
// The list opens in place (no pop-up), so every row is a plain tap.
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand, radius } from '@/theme';

export function PropertySwitcher() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const [open, setOpen] = useState(false);
  const mine = (me?.owner_accounts ?? []).filter((o) => o.role === 'owner' || o.role === 'co_owner');
  const current = ownerAccountId(me);
  if (mine.length === 0) return null;
  const nameOf = (o: (typeof mine)[number], i: number) => o.property_name || o.property_address || `${t('property.newProperty')} ${mine.length > 1 ? i + 1 : ''}`.trim();
  const icon = (o: (typeof mine)[number]) => (o.property_status === 'submitted' ? 'clock-outline' : o.property_status === 'verified' ? 'home-city-outline' : 'home-plus-outline');
  const idx = Math.max(0, mine.findIndex((o) => o.owner_account_id === current));
  const sel = mine[idx];
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ fontWeight: '800', color: brand.teal900 }}>{`${t('property.listLabel')}:`}</Text>
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="property-dropdown"
                   accessibilityLabel={`${t('property.title')}: ${nameOf(sel, idx)}`}
                   style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.md,
                            backgroundColor: '#fff', borderWidth: 1.5, borderColor: open ? brand.teal700 : brand.line }}>
          <Icon source={icon(sel)} size={18} color={brand.teal700} />
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '800', color: brand.ink }}>{nameOf(sel, idx)}</Text>
          <Icon source={open ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </Pressable>
      </View>
      {open ? (
        <View style={{ marginLeft: 0, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden' }}>
          {mine.map((o, i) => {
            const on = o.owner_account_id === current;
            return (
              <Pressable key={o.owner_account_id} onPress={() => { setOpen(false); selectOwner(o.owner_account_id); }} accessibilityRole="button"
                         accessibilityState={{ selected: on }} testID={`property-${i}`}
                         style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13,
                                                    backgroundColor: on ? brand.teal50 : pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
                <Icon source={on ? 'check-circle' : icon(o)} size={20} color={brand.teal700} />
                <Text numberOfLines={1} style={{ flex: 1, fontWeight: on ? '800' : '600', color: brand.ink }}>{nameOf(o, i)}</Text>
                {o.property_status === 'submitted' ? <Text variant="labelSmall" style={{ color: '#B45309' }}>{t('property.verifying')}</Text> : null}
              </Pressable>
            );
          })}
          <Pressable onPress={() => { setOpen(false); router.push('/(app)/owner/add-property'); }} accessibilityRole="button" testID="add-property"
                     style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: pressed ? brand.teal50 : '#fff' })}>
            <Icon source="plus-circle-outline" size={20} color={brand.teal700} />
            <Text style={{ fontWeight: '800', color: brand.teal700 }}>{t('property.add')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
