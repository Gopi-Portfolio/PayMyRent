// Renters who asked to vacate. Approving ends that rental (the place shows as vacant); declining keeps it and tells the renter.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { Avatar, ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { dmyToIso, fmtDate } from '@/lib/dates';
import { formatINR } from '@/lib/format';
import { brand } from '@/theme';

function Request({ r, owner }: { r: any; owner: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [date, setDate] = useState(fmtDate(r.move_out_date));
  const [deposit, setDeposit] = useState('');
  const [handover, setHandover] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const iso = dmyToIso(date);
  const ok = !!iso && iso > String(r.start_date);
  const run = async (body: object) => {
    setBusy(true); setErr(null);
    try { await api(`/api/v1/owner/vacate-requests/${r.id}/decide`, { ownerAccount: owner, body }); qc.invalidateQueries(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Panel tone="red" icon="door-open" title={`${r.identifier} · ${r.tenant_name ?? ''}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={r.tenant_name ?? r.identifier} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: '700' }}>{t('vacate.ownerAsked', { date: fmtDate(r.move_out_date) })}</Text>
          {r.reason ? <Text variant="bodySmall" style={{ color: brand.muted }}>{r.reason}</Text> : null}
          <Text variant="bodySmall" style={{ color: brand.muted }}>{t('tenancy.vacateInfo', { held: formatINR(r.deposit_held_paise ?? 0), due: formatINR(Math.max(r.balance_paise ?? 0, 0)) })}</Text>
        </View>
      </View>
      <ErrorBanner error={err} />
      <Field label={`${t('tenancy.vacatedOn')} (DD-MM-YYYY)`} value={date} onChangeText={setDate} kind="date" error={ok ? undefined : 'date_invalid'} testID={`vacate-end-${r.id}`} />
      <Field label={t('tenancy.depositNote')} value={deposit} onChangeText={setDeposit} kind="reason" />
      <Field label={t('tenancy.handoverNote')} value={handover} onChangeText={setHandover} kind="reason" />
      <Field label={t('vacate.declineNote')} value={note} onChangeText={setNote} kind="reason" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><AppButton variant="outline" label={t('relief.decline')} disabled={busy} testID={`vacate-decline-${r.id}`} onPress={() => run({ action: 'decline', note: note.trim() || null })} /></View>
        <View style={{ flex: 2 }}><AppButton label={t('relief.approve')} icon="check" disabled={busy || !ok} loading={busy} testID={`vacate-approve-${r.id}`}
                                           onPress={() => run({ action: 'approve', end_date: iso, deposit_note: deposit.trim() || null, handover_note: handover.trim() || null })} /></View>
      </View>
    </Panel>
  );
}

export default function VacateRequests() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const q = useQuery({ queryKey: ['vacate-pending', owner], queryFn: () => api<any>('/api/v1/owner/vacate-requests', { ownerAccount: owner }) });
  const items: any[] = q.data?.items ?? [];
  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {q.data && items.length === 0 ? <Text style={{ color: brand.muted, textAlign: 'center', paddingVertical: 24 }}>{t('vacate.none')}</Text> : null}
      {items.map((r) => <Request key={r.id} r={r} owner={owner} />)}
    </Screen>
  );
}
