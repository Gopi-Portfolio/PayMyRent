// My properties: each one has its own plan, units and vacancy. Tap one to work on it.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Panel, Screen, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand, radius, shadow } from '@/theme';

export default function MyProperties() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const current = ownerAccountId(me);
  const q = useQuery({ queryKey: ['workspaces', me?.id], queryFn: () => api<any>('/api/v1/owner/workspaces') });
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {(q.data?.items ?? []).map((w: any) => (
        <Pressable key={w.owner_account_id} onPress={() => { selectOwner(w.owner_account_id); router.replace('/(app)/owner'); }} accessibilityRole="button"
                   style={[{ backgroundColor: '#fff', borderRadius: radius.lg, padding: 14, gap: 8, borderWidth: w.owner_account_id === current ? 2 : 1,
                             borderColor: w.owner_account_id === current ? brand.teal700 : brand.line }, shadow]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon source="home-city-outline" size={24} color={brand.teal700} />
            <Text variant="titleSmall" style={{ flex: 1, fontWeight: '800' }} numberOfLines={1}>{w.property?.name || w.property?.address || t('property.newProperty')}</Text>
            {w.property ? <StatusPill status={w.property.verification_status === 'submitted' ? t('property.statusSubmitted') : w.property.verification_status === 'verified' ? t('property.statusVerified') : t('property.statusRejected')} /> : null}
          </View>
          {w.property ? <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={2}>{`${w.property.address}, ${w.property.city} ${w.property.pincode}`}</Text>
                      : <Text variant="bodySmall" style={{ color: '#B45309' }}>{t('property.addYourProperty')}</Text>}
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Text style={{ fontWeight: '700' }}>{w.plan ? `${t('property.plan')}: ${String(w.plan).charAt(0).toUpperCase()}${String(w.plan).slice(1)}` : t('property.noPlan')}</Text>
            <Text style={{ fontWeight: '700' }}>{t('property.unitsOf', { used: w.active_units, cap: w.units_capacity })}</Text>
            <Text style={{ fontWeight: '700', color: w.vacant_units ? '#B45309' : brand.muted }}>{`${t('property.vacant')}: ${w.vacant_units}`}</Text>
          </View>
        </Pressable>
      ))}
      <AppButton label={t('property.addAnother')} icon="plus" onPress={() => router.push('/(app)/owner/add-property')} />
    </Screen>
  );
}
