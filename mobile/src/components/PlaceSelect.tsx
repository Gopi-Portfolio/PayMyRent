// The places already in this property, as a dropdown that opens in place (no pop-up). A free place can be picked; an occupied one stays
// locked and disabled, with the renter's name, until that renter is vacated. Closed, it takes the space of one line.
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { floorChip } from '@/lib/units';
import { brand, radius } from '@/theme';

export type Place = { id: string; identifier: string; floor?: number | null; vacant?: boolean; tenancy_id?: string | null; tenant_name?: string | null; pending?: boolean };
export const isLocked = (u: Place) => !u.vacant && !!u.tenancy_id;

export function PlaceSelect({ places, selectedId, onPick }: { places: Place[]; selectedId?: string | null; onPick: (u: Place) => void }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const tag = (u: Place) => (u.floor !== null && u.floor !== undefined ? ` · ${floorChip(u.floor, t, i18n.language)}` : '');
  const sel = places.find((u) => u.id === selectedId);
  const taken = places.filter(isLocked).length;
  const free = places.length - taken;
  const ordered = [...places.filter((u) => !isLocked(u)), ...places.filter(isLocked)];       // vacant units first, the ones already rented below them
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
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden', maxHeight: 320 }}>
          {/* how many can be chosen and how many are already rented */}
          <Text style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: brand.teal50, color: brand.muted, fontWeight: '700', fontSize: 12 }} testID="unit-counts">
            {t('tenancy.unitCounts', { vacant: free, occupied: taken })}
          </Text>
          <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {ordered.map((u) => {
              const locked = isLocked(u);
              const on = u.id === selectedId;
              const base = locked ? (u.tenant_name ? t('tenancy.rentedTo', { name: u.tenant_name }) : t('tenancy.occupiedNoName')) : t('property.vacant');
              const status = u.pending ? `${base} · ${t('offline.statusWaiting')}` : base;          // saved on this phone, not yet sent
              return (
                <Pressable key={u.id} disabled={locked} onPress={() => { setOpen(false); onPick(u); }} accessibilityRole="button" accessibilityState={{ disabled: locked, selected: on }}
                           accessibilityLabel={`${u.identifier}. ${status}${locked ? `. ${t('tenancy.occupiedLocked')}` : ''}`} testID={`unit-${locked ? 'locked' : 'free'}-${u.identifier}`}
                           style={({ pressed }) => ({ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: brand.line,
                                                      backgroundColor: locked ? brand.disabledBg : on || pressed ? brand.teal50 : '#fff' })}>
                  <View style={{ width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: locked ? '#E3E8E6' : brand.green100 }}>
                    <Icon source={locked ? 'lock-outline' : on ? 'check-circle' : 'door-open'} size={20} color={locked ? brand.disabled : brand.green600} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontWeight: '800', fontSize: 16, color: locked ? brand.disabled : brand.ink }}>{`${u.identifier}${tag(u)}`}</Text>
                    <Text numberOfLines={1} testID={`unit-status-${u.identifier}`} style={{ fontSize: 13, fontWeight: '700', color: locked ? brand.muted : brand.green600 }}>{status}</Text>
                  </View>
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
