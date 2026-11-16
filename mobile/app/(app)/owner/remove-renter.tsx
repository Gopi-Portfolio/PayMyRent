// Remove Renter: every renter living in (or invited to) a unit, across all properties or one property chosen from the list. Each row has its own red Remove
// button (opens that renter's page with the removal open, showing rent due and deposit held), or tick several and remove them together.
// Together: renters living in a unit are moved out today and invitations are cancelled; dues and deposits are settled later from each renter's page.
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton, Button } from '@/components/Buttons';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Avatar, ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth, ownerProperties } from '@/lib/auth';
import { confirmRemove } from '@/lib/confirm';
import { dmyToIso, todayDMY } from '@/lib/dates';
import { brand, radius } from '@/theme';

export default function RemoveRenter() {
  const { t } = useTranslation();
  const { me, selectOwner } = useAuth();
  const qc = useQueryClient();
  const mine = ownerProperties(me);
  const [q, setQ] = React.useState('');
  const [property, setProperty] = React.useState<string>('all');
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ done: number; failed: string[] } | null>(null);
  const [err, setErr] = React.useState<unknown>(null);
  // every property's renters together
  const lists = useQueries({ queries: mine.map((o) => ({ queryKey: ['tenancies', o.owner_account_id, 'live-all'], queryFn: () => api<any>('/api/v1/owner/tenancies?status=live', { ownerAccount: o.owner_account_id }) })) });
  const all: any[] = lists.flatMap((x, i) => (x.data?.items ?? []).map((it: any) => ({ ...it, _owner: mine[i].owner_account_id, _property: mine[i].property_name || mine[i].property_address || null })));
  const needle = q.trim().toLowerCase();
  const items = all.filter((x) => (property === 'all' || x._owner === property) && (!needle || `${x.tenant_name ?? ''} ${x.identifier}`.toLowerCase().includes(needle)));
  const nameOf = (o: (typeof mine)[number], i: number) => o.property_name || o.property_address || `${t('property.newProperty')} ${i + 1}`;
  const chosen = items.filter((x) => picked.has(x.id));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allTicked = items.length > 0 && chosen.length === items.length;

  async function removeChosen() {
    setBusy(true); setErr(null); setResult(null);
    const iso = dmyToIso(todayDMY());
    const failed: string[] = []; let done = 0;
    for (const x of chosen) {          // one after another, so one refusal never stops the rest
      try {
        if (x.status === 'invited') await api(`/api/v1/owner/tenancies/${x.id}/cancel-invite`, { method: 'POST', ownerAccount: x._owner });
        else await api(`/api/v1/owner/tenancies/${x.id}/end?end_date=${iso}`, { method: 'POST', ownerAccount: x._owner, body: {} });
        done += 1;
      } catch { failed.push(x.tenant_name ?? x.identifier); }
    }
    setBusy(false); setResult({ done, failed }); setPicked(new Set());
    qc.invalidateQueries();
  }
  const askBulk = () => confirmRemove(t('renter.bulkTitle', { count: chosen.length }), t('renter.bulkBody'), t('renter.removeSelected', { count: chosen.length }), () => { void removeChosen(); });

  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{t('renter.removePageTitle')}</Text>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('renter.removePageHelp')}</Text>
      </View>
      <ErrorBanner error={err || lists.find((x) => x.error)?.error} onRetry={() => lists.forEach((x) => x.refetch())} />
      {mine.length > 1 ? (
        <SearchableSelect label={t('tenancy.property')} value={property} onChange={(v) => { setProperty(v); setPicked(new Set()); }}
                          options={[{ value: 'all', label: t('property.allCount', { count: mine.length }) }, ...mine.map((o, i) => ({ value: o.owner_account_id, label: nameOf(o, i), subtitle: o.property_address ?? undefined }))]} />
      ) : null}
      {all.length > 5 ? <Field label={t('common.search')} value={q} onChangeText={setQ} kind="name" testID="remove-search" /> : null}
      {result ? (
        <View style={{ gap: 4, backgroundColor: result.failed.length ? brand.amber100 : brand.green100, borderRadius: radius.md, padding: 12 }} testID="bulk-result">
          <Text style={{ fontWeight: '800', color: result.failed.length ? '#7C4A03' : brand.green600 }}>{t('renter.bulkDone', { count: result.done })}</Text>
          {result.failed.length ? <Text style={{ color: '#7C4A03', lineHeight: 20 }}>{t('renter.bulkFailed', { names: result.failed.join(', ') })}</Text> : null}
        </View>
      ) : null}
      {items.length > 1 ? (
        <Pressable onPress={() => setPicked(allTicked ? new Set() : new Set(items.map((x) => x.id)))} accessibilityRole="checkbox" accessibilityState={{ checked: allTicked }} testID="select-all"
                   style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
          <Icon source={allTicked ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} color={allTicked ? brand.teal700 : brand.muted} />
          <Text style={{ fontWeight: '700', color: brand.ink }}>{t('renter.selectAll')}</Text>
        </Pressable>
      ) : null}
      {items.map((x: any) => {
        const on = picked.has(x.id);
        return (
          <Panel key={x.id}>
            <Pressable onPress={() => toggle(x.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} testID={`pick-${x.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon source={on ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={on ? brand.teal700 : brand.muted} />
              <Avatar name={x.tenant_name ?? x.identifier} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: '800' }} numberOfLines={1}>{x.tenant_name ?? x.identifier}</Text>
                <Text variant="bodySmall" style={{ color: brand.muted }} numberOfLines={1}>{[x.identifier, mine.length > 1 ? x._property : null, x.status === 'invited' ? t('tenancy.invited') : null].filter(Boolean).join(' · ')}</Text>
              </View>
            </Pressable>
            <View style={{ marginTop: 10 }}>
              <Button textColor="crimson" icon="account-remove-outline" testID={`remove-${x.id}`}
                      onPress={() => { selectOwner(x._owner); router.push({ pathname: `/(app)/owner/tenancy/${x.id}`, params: { remove: '1' } }); }}>{t('renter.remove')}</Button>
            </View>
          </Panel>
        );
      })}
      {!items.length && !lists.some((x) => x.isLoading) ? <Text style={{ color: brand.muted, textAlign: 'center', padding: 20 }} testID="no-live-renters">{t('renter.removeNone')}</Text> : null}
      {chosen.length > 0 ? (
        <AppButton label={t('renter.removeSelected', { count: chosen.length })} icon="account-remove" onPress={askBulk} loading={busy} disabled={busy} testID="remove-selected" />
      ) : null}
    </Screen>
  );
}
