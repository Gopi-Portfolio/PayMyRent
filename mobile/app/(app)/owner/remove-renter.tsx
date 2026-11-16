// Remove Renter: every renter living in (or invited to) a unit, with a red Remove button on each. Pressing it opens that renter's page with the removal
// already open (the rent due and deposit held are shown there before anything is confirmed), so it is two taps from the home screen.
import { useQueries } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Buttons';
import { Avatar, ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export default function RemoveRenter() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const mine = (me?.owner_accounts ?? []).filter((o) => o.role === 'owner' || o.role === 'co_owner');
  const [q, setQ] = React.useState('');
  // every property's renters together
  const lists = useQueries({ queries: mine.map((o) => ({ queryKey: ['tenancies', o.owner_account_id, 'live-all'], queryFn: () => api<any>('/api/v1/owner/tenancies?status=live', { ownerAccount: o.owner_account_id }) })) });
  const list = { error: lists.find((x) => x.error)?.error, isLoading: lists.some((x) => x.isLoading), refetch: () => lists.forEach((x) => x.refetch()),
                 data: { items: lists.flatMap((x, i) => (x.data?.items ?? []).map((it: any) => ({ ...it, _owner: mine[i].owner_account_id, _property: mine[i].property_name || mine[i].property_address || null }))) } };
  const needle = q.trim().toLowerCase();
  const items = (list.data?.items ?? []).filter((x: any) => !needle || `${x.tenant_name ?? ''} ${x.identifier}`.toLowerCase().includes(needle));
  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{t('renter.removePageTitle')}</Text>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('renter.removePageHelp')}</Text>
      </View>
      <ErrorBanner error={list.error} onRetry={() => list.refetch()} />
      {(list.data?.items ?? []).length > 5 ? <Field label={t('common.search')} value={q} onChangeText={setQ} kind="name" testID="remove-search" /> : null}
      {items.map((x: any) => (
        <Panel key={x.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Avatar name={x.tenant_name ?? x.identifier} size={44} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800' }} numberOfLines={1}>{x.tenant_name ?? x.identifier}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={1}>{[x.identifier, mine.length > 1 ? x._property : null, x.status === 'invited' ? t('tenancy.invited') : null].filter(Boolean).join(' · ')}</Text>
            </View>
          </View>
          <View style={{ marginTop: 10 }}>
            <Button textColor="crimson" icon="account-remove-outline" testID={`remove-${x.id}`}
                    onPress={() => { selectOwner(x._owner); router.push({ pathname: `/(app)/owner/tenancy/${x.id}`, params: { remove: '1' } }); }}>{t('renter.remove')}</Button>
          </View>
        </Panel>
      ))}
      {!items.length && !list.isLoading ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 20 }} testID="no-live-renters">{t('renter.removeNone')}</Text> : null}
    </Screen>
  );
}
