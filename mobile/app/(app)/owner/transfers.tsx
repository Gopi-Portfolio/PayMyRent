// UPI / bank payments the tenants say they made. The owner checks their own bank or UPI app, then confirms or rejects each one.
// Confirming puts the money in the tenant's account and gives a receipt. Rejecting changes nothing.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Dialog, Portal, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Buttons';
import { Avatar, ErrorBanner, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { brand } from '@/theme';

export default function Transfers() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['transfers', owner], refetchInterval: 20000, queryFn: () => api<any>('/api/v1/owner/payments/pending-transfers', { ownerAccount: owner }) });
  const [ask, setAsk] = useState<{ item: any; action: 'confirm' | 'reject' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const items: any[] = q.data?.items ?? [];

  async function go() {
    if (!ask) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/owner/payments/${ask.item.id}/${ask.action}-transfer`, { method: 'POST', ownerAccount: owner, body: ask.action === 'reject' ? {} : undefined });
      qc.invalidateQueries();
      setAsk(null);
    } catch (e) { setErr(e); setAsk(null); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('transfers.intro')}</Text>
      <ErrorBanner error={err || q.error} onRetry={() => q.refetch()} />
      {!q.isLoading && items.length === 0 ? <Panel><Text style={{ color: brand.muted }} testID="transfers-empty">{t('transfers.empty')}</Text></Panel> : null}
      {items.map((i) => (
        <Panel key={i.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={i.tenant_name ?? i.identifier} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800', fontSize: 16 }} numberOfLines={1}>{i.tenant_name ?? i.identifier}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }}>{`${i.identifier} · ${t('transfers.paidOn', { date: fmtDate(i.paid_on) })}`}</Text>
            </View>
            <Text style={{ fontWeight: '800', fontSize: 20, color: brand.green600 }}>{i.amount_display}</Text>
          </View>
          <View style={{ backgroundColor: brand.teal50, borderRadius: 12, padding: 10 }}>
            <Text variant="bodySmall" style={{ color: brand.muted }}>{t('upi.ref')}</Text>
            <Text selectable style={{ fontWeight: '800', fontSize: 16 }} testID={`transfer-ref-${i.id}`}>{i.reference}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Button mode="outlined" icon="close" onPress={() => setAsk({ item: i, action: 'reject' })} testID={`transfer-reject-${i.id}`}>{t('transfers.reject')}</Button></View>
            <View style={{ flex: 1 }}><Button mode="contained" icon="check" onPress={() => setAsk({ item: i, action: 'confirm' })} testID={`transfer-confirm-${i.id}`}>{t('transfers.confirm')}</Button></View>
          </View>
        </Panel>
      ))}
      <Portal>
        <Dialog visible={!!ask} onDismiss={() => setAsk(null)}>
          <Dialog.Title>{ask?.action === 'confirm' ? t('transfers.confirmQ') : t('transfers.rejectQ')}</Dialog.Title>
          <Dialog.Content style={{ gap: 10 }}>
            <Text style={{ fontWeight: '800' }}>{`${ask?.item.tenant_name ?? ''} · ${ask?.item.identifier ?? ''}`}</Text>
            <Text style={{ fontSize: 22, fontWeight: '800' }}>{ask?.item.amount_display}</Text>
            <Text style={{ lineHeight: 21 }}>{ask?.action === 'confirm' ? t('transfers.confirmBody', { ref: ask?.item.reference }) : t('transfers.rejectBody')}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsk(null)}>{t('common.cancel')}</Button>
            <Button onPress={go} loading={busy} testID="transfer-go">{ask?.action === 'confirm' ? t('transfers.yesConfirm') : t('transfers.yesReject')}</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </Screen>
  );
}
