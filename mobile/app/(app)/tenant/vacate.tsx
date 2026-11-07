// Close an account / leave a place: a renter picks which rental they want to end, and the request goes to THAT owner only.
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { RenterVacate } from '@/components/VacateRequest';
import { Avatar, ErrorBanner, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { brand } from '@/theme';

export default function VacateRentals() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['rentals'], queryFn: () => api<any>('/api/v1/tenant/rentals') });
  const active: any[] = (q.data?.items ?? []).filter((r: any) => r.status === 'active');
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      <Text style={{ lineHeight: 22 }}>{t('vacate.pickHelp')}</Text>
      {q.data && active.length === 0 ? <Text style={{ color: brand.muted, textAlign: 'center', paddingVertical: 24 }}>{t('vacate.noRentals')}</Text> : null}
      {active.map((r) => (
        <Panel key={r.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={r.owner_name} size={44} />
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall" style={{ fontWeight: '800' }}>{`${r.identifier} · ${r.property_name ?? r.address}`}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{t('vacate.owner', { owner: r.owner_name })}</Text>
            </View>
          </View>
          <RenterVacate rental={r} />
        </Panel>
      ))}
    </Screen>
  );
}
