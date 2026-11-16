// The places of ONE property (houses, flats, rooms, shops): the list, and the only form in the app where a new place is entered.
// Add Renter just picks from these. The server checks the name is not already used on the same floor and that the plan has room.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { FloorSelect } from '@/components/FloorSelect';
import { ErrorBanner, Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { KIND_GROUPS, type KindGroup, floorChip, kindIcon } from '@/lib/units';
import { submitOrQueue } from '@/lib/offline';
import { addPendingUnit } from '@/lib/optimistic';
import { placeSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

export function PlacesManager({ propertyId, owner, propertyName, onDone }: { propertyId: string; owner?: string; propertyName?: string; onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const units = useQuery({ queryKey: ['units', owner, 'active'], queryFn: () => api<any>('/api/v1/owner/units?status=active', { ownerAccount: owner }) });
  const places: any[] = (units.data?.items ?? []).filter((u: any) => u.property_id === propertyId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<KindGroup>('residential');
  const [floor, setFloor] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [added, setAdded] = useState<string | null>(null);
  const nameErr = placeSchema.safeParse(name).success ? undefined : placeSchema.safeParse(name).error!.issues[0].message;

  async function add() {
    setTouched(true); setErr(null); setAdded(null);
    if (nameErr) return;
    setBusy(true);
    try {
      const sent = await submitOrQueue<any>({
        kind: 'unit.create', label: t('offline.itemUnit', { name }), path: '/api/v1/owner/units', ownerAccount: owner, body: { property_id: propertyId, identifier: name, kind, floor },
        optimistic: (item) => addPendingUnit(owner, item.id, { property_id: propertyId, identifier: name, kind, floor }),
      });
      setAdded(sent.queued ? name : sent.result.identifier); setName(''); setTouched(false);
      if (!sent.queued) { qc.invalidateQueries({ queryKey: ['units'] }); qc.invalidateQueries({ queryKey: ['properties'] }); qc.invalidateQueries({ queryKey: ['vacant'] }); }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <>
      <Panel title={`${t('tenancy.unitsHere')} (${places.length})${propertyName ? ` · ${propertyName}` : ''}`} icon="door-open" tone="teal">
        {places.length === 0 ? <Text style={{ color: brand.muted }}>{t('property.noPlacesYet')}</Text> : null}
        {places.map((u: any) => (
          <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon source={kindIcon(u.kind === 'residential' ? 'residential' : 'commercial')} size={20} color={brand.teal700} />
            <Text style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>{`${u.identifier}${u.floor !== null && u.floor !== undefined ? ` · ${floorChip(u.floor, t, i18n.language)}` : ''}`}</Text>
            <Text style={{ color: u.vacant ? brand.green600 : '#B45309', fontWeight: '700' }}>{u.vacant ? t('property.vacant') : (u.tenant_name ?? t('tenancy.occupiedLocked'))}</Text>
          </View>
        ))}
      </Panel>
      <Panel title={t('property.addPlace')} icon="plus-circle-outline" tone="green">
        <View style={{ flexDirection: 'row', gap: 8 }} testID="unit-kind">
          {KIND_GROUPS.map((g) => {
            const on = kind === g.group;
            return (
              <Pressable key={g.group} onPress={() => setKind(g.group)} accessibilityRole="button" accessibilityState={{ selected: on }} testID={`kind-${g.group}`}
                         style={{ flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1.5, borderColor: on ? brand.teal700 : brand.line, backgroundColor: on ? brand.teal50 : '#fff' }}>
                <Icon source={kindIcon(g.group)} size={22} color={on ? brand.teal700 : brand.muted} />
                <Text style={{ fontWeight: '800', color: on ? brand.teal700 : brand.ink, fontSize: 12 }} numberOfLines={1}>{t(`tenancy.kind_${g.group}`)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text variant="bodySmall" style={{ color: brand.muted }}>{t(kind === 'commercial' ? 'tenancy.kindCommercialHelp' : 'tenancy.kindResidentialHelp')}</Text>
        <Field label={kind === 'commercial' ? t('tenancy.unitCommercial') : t('tenancy.unit')} value={name} onChangeText={setName} kind="place" testID="unit-name"
               error={touched ? nameErr : undefined} />
        <FloorSelect value={floor} onChange={setFloor} />
        <ErrorBanner error={err} />
        {added ? <Text style={{ color: brand.green600, fontWeight: '700' }} accessibilityLiveRegion="polite" testID="place-added">{t('property.placeAdded', { defaultValue: '{{name}} added. You can add another.', name: added })}</Text> : null}
        <AppButton label={t('property.addPlace')} icon="plus" loading={busy} disabled={busy} onPress={add} testID="add-place" />
      </Panel>
      {onDone ? <AppButton variant="outline" label={t('common.done', { defaultValue: 'Done' })} icon="check" onPress={onDone} testID="places-done" /> : null}
    </>
  );
}
