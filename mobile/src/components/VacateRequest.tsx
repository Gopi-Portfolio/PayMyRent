// A renter cannot close a rental alone. They ask the owner of THAT place to let them vacate; only that owner is told and only that owner
// can approve. The card shows where the request stands. (The owner answers in app/(app)/owner/vacate.tsx.)
import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton, Button } from '@/components/Buttons';
import { ErrorBanner, Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { dmyToIso, fmtDate } from '@/lib/dates';
import { brand } from '@/theme';

const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export function RenterVacate({ rental }: { rental: any }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(fmtDate(plusDays(30)));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const v = rental?.vacate;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); ['rentals', 'notifications', 'updates'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); setOpen(false); setReason(''); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (rental?.status !== 'active') return null;

  if (v?.status === 'requested') {
    return (
      <Panel tone="amber" icon="clock-outline" title={t('vacate.waitingTitle')}>
        <Text>{t('vacate.waitingText', { owner: rental.owner_name, date: fmtDate(v.move_out_date) })}</Text>
        <ErrorBanner error={err} />
        <Button icon="close-circle-outline" onPress={() => run(() => api(`/api/v1/vacate-requests/${v.id}/cancel`, { method: 'POST' }))} testID="vacate-cancel">{t('vacate.cancel')}</Button>
      </Panel>
    );
  }
  const iso = dmyToIso(date);
  const ok = !!iso && iso >= plusDays(0) && iso <= plusDays(366);
  return (
    <View style={{ gap: 8 }}>
      {v?.status === 'declined' ? (
        <Panel tone="red" icon="close-circle-outline" title={t('vacate.declinedTitle')}>
          <Text>{t('vacate.declinedText', { owner: rental.owner_name })}</Text>
          {v.owner_note ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 4 }}>{v.owner_note}</Text> : null}
        </Panel>
      ) : null}
      {!open ? <Button icon="door-open" textColor="crimson" onPress={() => setOpen(true)} testID="vacate-ask-open">{t('vacate.ask', { unit: rental.identifier })}</Button> : (
        <Panel tone="red" icon="door-open" title={t('vacate.askTitle', { unit: rental.identifier })}>
          <Text variant="bodySmall" style={{ color: brand.muted, marginBottom: 8 }}>{t('vacate.help', { owner: rental.owner_name })}</Text>
          <ErrorBanner error={err} />
          <Field label={`${t('vacate.moveOut')} (DD-MM-YYYY)`} value={date} onChangeText={setDate} kind="date" error={ok ? undefined : 'date_invalid'} testID="vacate-date" />
          <Field label={t('vacate.reason')} value={reason} onChangeText={setReason} kind="reason" testID="vacate-reason" />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><AppButton variant="outline" label={t('common.cancel')} onPress={() => setOpen(false)} /></View>
            <View style={{ flex: 2 }}>
              <AppButton label={t('vacate.send')} icon="send" disabled={busy || !ok} loading={busy} testID="vacate-send"
                         onPress={() => run(() => api(`/api/v1/tenancies/${rental.id}/vacate-request`, { body: { move_out_date: iso, reason: reason.trim() || null } }))} />
            </View>
          </View>
        </Panel>
      )}
    </View>
  );
}
