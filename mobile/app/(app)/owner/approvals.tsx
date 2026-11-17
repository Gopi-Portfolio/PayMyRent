import { useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtMonth } from '@/lib/dates';
import { ErrorBanner, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { formatINR } from '@/lib/format';
import { brand } from '@/theme';

export default function Approvals() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['approvals', owner], queryFn: () => api<any>('/api/v1/owner/charge-submissions', { ownerAccount: owner }) });
  const review = async (id: string, approve: boolean) => {
    await api(`/api/v1/owner/charge-submissions/${id}/review`, { ownerAccount: owner, body: { approve, reason: approve ? null : 'rejected' } });
    qc.invalidateQueries();
  };
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {(q.data?.items ?? []).map((s: any) => (
        <Panel key={s.id} title={`${s.identifier} · ${t(`bill.${s.category}`)}`} icon="flash-outline" tone="amber">
          <Text style={{ fontSize: 26, fontWeight: '800' }}>{formatINR(s.amount_paise)}</Text>
          <Text variant="bodySmall" style={{ color: brand.muted, marginBottom: 10 }}>{`${fmtMonth(s.period_month)} · ${s.reading_previous ?? '–'} → ${s.reading_current ?? '–'}`}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Button mode="outlined" icon="close" onPress={() => review(s.id, false)}>{t('tenant.reject')}</Button></View>
            <View style={{ flex: 1 }}><Button mode="contained" icon="check" onPress={() => review(s.id, true)}>{t('tenant.accept')}</Button></View>
          </View>
        </Panel>
      ))}
    </Screen>
  );
}
