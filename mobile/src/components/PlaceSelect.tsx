// The places already in this property, as a dropdown that opens in place (no pop-up). A free place can be picked; an occupied one stays
// locked and disabled, with the renter's name, until that renter is vacated. Closed, it takes the space of one line.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { floorChip } from '@/lib/units';
import { brand, radius } from '@/theme';

export type Place = { id: string; identifier: string; floor?: number | null; vacant?: boolean; tenancy_id?: string | null; tenant_name?: string | null };
export const isLocked = (u: Place) => !u.vacant && !!u.tenancy_id;

export function PlaceSelect({ places, selectedId, onPick }: { places: Place[]; selectedId?: string | null; onPick: (u: Place) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const tag = (u: Place) => (u.floor !== null && u.floor !== undefined ? ` · ${floorChip(u.floor, t, i18n.language)}` : '');
  const sel = places.find((u) => u.id === selectedId);
  const taken = places.filter(isLocked).length;
  return (
    <View style={{ gap: 6 }} testID="property-units">
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="places-dropdown"
                 accessibilityLabel={`${t('tenancy.unitsHere')}: ${sel ? sel.identifier : t('tenancy.pickPlace')}`}
                 style={{ height: 58, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1.5, borderColor: open ? brand.teal700 : brand.line }}>
        <Text variant="labelSmall" style={{ color: brand.muted }}>{`${t('tenancy.unitsHere')} (${places.length})`}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '700', color: sel ? brand.ink : brand.muted }}>{sel ? `${sel.identifier}${tag(sel)}` : t('tenancy.pickPlace')}</Text>
          <Icon source={open ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden', maxHeight: 264 }}>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {places.map((u) => {
              const locked = isLocked(u);
              const on = u.id === selectedId;
              return (
                <Pressable key={u.id} disabled={locked} onPress={() => { setOpen(false); onPick(u); }} accessibilityRole="button" accessibilityState={{ disabled: locked, selected: on }}
                           accessibilityLabel={locked ? `${u.identifier}. ${t('tenancy.occupiedLocked')}` : u.identifier} testID={`unit-${locked ? 'locked' : 'free'}-${u.identifier}`}
                           style={({ pressed }) => ({ height: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: brand.line,
                                                      backgroundColor: locked ? brand.disabledBg : on || pressed ? brand.teal50 : '#fff' })}>
                  <Icon source={locked ? 'lock-outline' : on ? 'check-circle' : 'door-open'} size={20} color={locked ? brand.disabled : brand.teal700} />
                  <Text numberOfLines={1} style={{ flex: 1, fontWeight: on ? '800' : '700', color: locked ? brand.disabled : brand.ink }}>{`${u.identifier}${tag(u)}`}</Text>
                  {locked && u.tenant_name ? <Text variant="labelSmall" numberOfLines={1} style={{ maxWidth: 120, color: brand.disabled }}>{u.tenant_name}</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {taken > 0 ? <Text variant="bodySmall" style={{ color: brand.muted }}>{t('tenancy.occupiedLocked')}</Text> : null}
      {places.every((u) => !u.vacant) ? <Text variant="bodySmall" style={{ color: '#B45309', fontWeight: '700' }} testID="no-free-unit">{t('tenancy.noFreeUnits')}</Text> : null}
    </View>
  );
}
