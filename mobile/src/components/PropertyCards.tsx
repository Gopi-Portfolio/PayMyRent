// The owner's properties as cards (each one has its own plan, units and vacancy). Tap one to work on it. Used in the Search tab.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ErrorBanner, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand, radius, shadow } from '@/theme';

export function PropertyCards({ term }: { term: string }) {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const current = ownerAccountId(me);
  const q = useQuery({ queryKey: ['workspaces', me?.id], queryFn: () => api<any>('/api/v1/owner/workspaces') });
  const needle = term.trim().toLowerCase();
  const items: any[] = (q.data?.items ?? []).filter((w: any) => !needle
    || `${w.property?.name ?? ''} ${w.property?.address ?? ''} ${w.property?.city ?? ''} ${w.property?.pincode ?? ''}`.toLowerCase().includes(needle));
  return (
    <View style={{ gap: 10 }}>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {items.map((w: any) => (
        <Pressable key={w.owner_account_id} onPress={() => { selectOwner(w.owner_account_id); router.navigate('/(app)/owner'); }} accessibilityRole="button" testID={`property-card-${w.owner_account_id}`}
                   style={[{ backgroundColor: '#fff', borderRadius: radius.lg, padding: 14, gap: 8, borderWidth: w.owner_account_id === current ? 2 : 1,
                             borderColor: w.owner_account_id === current ? brand.teal700 : brand.line }, shadow]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon source="home-city-outline" size={22} color={brand.teal700} />
            <Text variant="titleSmall" style={{ flex: 1, fontWeight: '800' }} numberOfLines={1}>{w.property?.name || w.property?.address || t('property.newProperty')}</Text>
            {w.property ? <StatusPill status={w.property.verification_status === 'submitted' ? t('property.statusSubmitted') : w.property.verification_status === 'verified' ? t('property.statusVerified') : t('property.statusRejected')} /> : null}
          </View>
          {w.property ? <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{`${w.property.address}, ${w.property.city} ${w.property.pincode}`}</Text>
                      : <Text variant="bodySmall" style={{ color: '#B45309' }}>{t('property.addYourProperty')}</Text>}
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            <Text style={{ fontWeight: '700', fontSize: 13 }}>{w.plan ? `${t('property.plan')}: ${String(w.plan).charAt(0).toUpperCase()}${String(w.plan).slice(1)}` : t('property.noPlan')}</Text>
            <Text style={{ fontWeight: '700', fontSize: 13 }}>{t('property.unitsOf', { used: w.active_units, cap: w.units_capacity })}</Text>
            <Text style={{ fontWeight: '700', fontSize: 13, color: w.vacant_units ? '#B45309' : brand.muted }}>{`${t('property.vacant')}: ${w.vacant_units}`}</Text>
          </View>
        </Pressable>
      ))}
      {!q.isLoading && items.length === 0 ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 20 }}>{t('searchTab.noProperties')}</Text> : null}
    </View>
  );
}
