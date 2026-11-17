// Rent relief, as the renter and the owner see it. The renter asks to pay less than the full month now; the owner agrees an amount
// (or grants it without being asked); the rest moves to next month. The numbers are the server's; the app only shows them.
import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton, Button } from '@/components/Buttons';
import { ErrorBanner, Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { fmtMonth } from '@/lib/dates';
import { formatINR, parseRupeesToPaise } from '@/lib/format';
import { brand, radius } from '@/theme';

const refreshAll = (qc: ReturnType<typeof useQueryClient>) => ['bill', 'tenancy', 'rentals', 'dash', 'updates', 'relief-pending', 'tenancies', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** What was agreed (or asked, or refused) for the month. Shown to both sides, inside the bill. */
export function ReliefSummary({ bill }: { bill: any }) {
  const { t } = useTranslation();
  const r = bill?.relief;
  if (!r) return null;
  if (r.status === 'approved') {
    return (
      <Panel tone="amber" icon="handshake-outline" title={t('relief.agreedTitle')}>
        <Row k={t('relief.fullBill')} v={formatINR(r.billed_paise)} />
        <Row k={t('relief.agreedNow')} v={formatINR(r.agreed_pay_paise)} strong />
        <Row k={t('relief.movesTo', { month: fmtMonth(r.next_month) })} v={formatINR(r.deferred_paise)} warn />
        {r.owner_note ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 6 }}>{r.owner_note}</Text> : null}
      </Panel>
    );
  }
  const owner = bill?.viewer_role === 'owner';           // the owner answers a request in the panel below; only the renter needs the status line
  if (r.status === 'requested' && !owner) {
    return (
      <Panel tone="amber" icon="clock-outline" title={t('relief.requestedTitle')}>
        <Text>{t('relief.requestedText', { amount: formatINR(r.requested_pay_paise ?? 0) })}</Text>
        {r.reason ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 4 }}>{r.reason}</Text> : null}
      </Panel>
    );
  }
  if (r.status === 'declined' && !owner) {
    return (
      <Panel tone="red" icon="close-circle-outline" title={t('relief.declinedTitle')}>
        <Text>{t('relief.declinedText')}</Text>
        {r.owner_note ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 4 }}>{r.owner_note}</Text> : null}
      </Panel>
    );
  }
  return null;
}

function Row({ k, v, strong, warn }: { k: string; v: string; strong?: boolean; warn?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ flex: 1, fontWeight: strong ? '800' : '600' }}>{k}</Text>
      <Text style={{ fontWeight: '800', color: warn ? brand.amber700 : brand.ink, fontVariant: ['tabular-nums'] }}>{v}</Text>
    </View>
  );
}

/** A small chip for a list row: where this month's relief request stands. `who` decides the wording. */
export function ReliefChip({ relief, who }: { relief: any; who: 'owner' | 'renter' }) {
  const { t } = useTranslation();
  if (!relief) return null;
  const s = relief.status;
  const text = s === 'requested' ? (who === 'owner' ? t('relief.chipAsked', { amount: formatINR(relief.requested_pay_paise ?? 0) }) : t('relief.chipSent'))
    : s === 'approved' ? t('relief.chipAgreed') : s === 'declined' ? t('relief.chipDeclined') : null;
  if (!text) return null;
  const bad = s === 'declined';
  return (
    <View testID="relief-chip" style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill,
                                         backgroundColor: bad ? brand.red100 : s === 'approved' ? brand.green100 : brand.amber100 }}>
      <Icon source={s === 'approved' ? 'handshake-outline' : bad ? 'close-circle-outline' : 'hand-heart-outline'} size={13} color={bad ? brand.red600 : s === 'approved' ? brand.green600 : brand.amber700} />
      <Text style={{ fontSize: 11, fontWeight: '800', color: bad ? brand.red600 : s === 'approved' ? brand.green600 : brand.amber700 }}>{text}</Text>
    </View>
  );
}

/** The most that can be asked for or agreed: just under what is unpaid, so that something does move to next month. */
const below = (openPaise: number) => Math.max(openPaise - 1, 0);

/** Renter: ask to pay less than the full month now, or take the request back. */
export function RenterRelief({ tenancyId, month, bill }: { tenancyId: string; month: string; bill: any }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const unpaid = Number(bill?.summary?.this_month_open_paise ?? 0);
  const r = bill?.relief;
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); refreshAll(qc); setOpen(false); setAmount(''); setReason(''); } catch (e) { setErr(e); } finally { setBusy(false); } };

  if (r?.status === 'requested' && r.initiated_by === 'renter') {
    return <Button icon="close-circle-outline" onPress={() => run(() => api(`/api/v1/rent-relief/${r.id}/cancel`, { method: 'POST' }))} testID="relief-cancel">{t('relief.cancel')}</Button>;
  }
  if (unpaid <= 0 || (r && r.status !== 'declined' && r.status !== 'cancelled')) return null;
  if (!open) return <Button icon="hand-heart-outline" onPress={() => setOpen(true)} testID="relief-open">{t('relief.ask')}</Button>;
  const paise = parseRupeesToPaise(amount);
  return (
    <Panel tone="amber" icon="hand-heart-outline" title={t('relief.ask')}>
      <Text variant="bodySmall" style={{ color: brand.muted, marginBottom: 8 }}>{t('relief.askHelp', { amount: formatINR(unpaid) })}</Text>
      <ErrorBanner error={err} />
      <Field label={t('relief.canPay')} value={amount} onChangeText={setAmount} kind="amount" maxPaise={below(unpaid)} testID="relief-amount" />
      <Field label={t('relief.reason')} value={reason} onChangeText={setReason} kind="reason" testID="relief-reason" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><AppButton variant="outline" label={t('common.cancel')} onPress={() => setOpen(false)} /></View>
        <View style={{ flex: 2 }}>
          <AppButton label={t('relief.send')} icon="send" disabled={busy || paise === null || paise >= unpaid} loading={busy} testID="relief-send"
                     onPress={() => run(() => api(`/api/v1/tenancies/${tenancyId}/rent-relief`, { body: { period_month: month, pay_amount: amount || '0', reason: reason.trim() || null } }))} />
        </View>
      </View>
    </Panel>
  );
}

/** Owner: answer the renter's request, or change what is payable for the month without being asked. */
export function OwnerRelief({ tenancyId, month, bill, owner }: { tenancyId: string; month: string; bill: any; owner: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const r = bill?.relief;
  const asked = r?.status === 'requested' ? r : null;
  const unpaid = Number(bill?.summary?.this_month_open_paise ?? 0);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); refreshAll(qc); setOpen(false); setAmount(''); setNote(''); } catch (e) { setErr(e); } finally { setBusy(false); } };
  React.useEffect(() => { if (asked && !amount) setAmount(String(Math.round(Number(asked.requested_pay_paise ?? 0) / 100))); }, [asked?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const given = r?.status === 'approved';
  if (unpaid <= 0 && !asked) return null;
  if (given) return null;
  if (!asked && !open) return <Button icon="hand-heart-outline" onPress={() => setOpen(true)} testID="relief-grant-open">{t('relief.grant')}</Button>;
  const paise = parseRupeesToPaise(amount || '0');
  const valid = paise !== null && paise < unpaid;
  return (
    <Panel tone="amber" icon="hand-heart-outline" title={asked ? t('relief.requestTitle') : t('relief.grant')}>
      {asked ? (
        <>
          <Text style={{ fontWeight: '700' }}>{t('relief.ownerAsked', { amount: formatINR(asked.requested_pay_paise ?? 0), due: formatINR(unpaid) })}</Text>
          {asked.reason ? <Text variant="bodySmall" style={{ color: brand.muted, marginTop: 2, marginBottom: 6 }}>{asked.reason}</Text> : null}
        </>
      ) : <Text variant="bodySmall" style={{ color: brand.muted, marginBottom: 8 }}>{t('relief.grantHelp', { amount: formatINR(unpaid) })}</Text>}
      <ErrorBanner error={err} />
      <Field label={t('relief.ownerAmount')} value={amount} onChangeText={setAmount} kind="amount" maxPaise={below(unpaid)} testID="relief-owner-amount" />
      {valid ? <Text variant="bodySmall" style={{ color: brand.amber700, fontWeight: '700', marginBottom: 6 }}>{t('relief.willMove', { amount: formatINR(unpaid - (paise ?? 0)) })}</Text> : null}
      <Field label={t('relief.note')} value={note} onChangeText={setNote} kind="reason" testID="relief-note" />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {asked ? (
          <View style={{ flex: 1 }}>
            <AppButton variant="outline" label={t('relief.decline')} disabled={busy} testID="relief-decline"
                       onPress={() => run(() => api(`/api/v1/owner/rent-relief/${asked.id}/decide`, { ownerAccount: owner, body: { action: 'decline', note: note.trim() || null } }))} />
          </View>
        ) : <View style={{ flex: 1 }}><AppButton variant="outline" label={t('common.cancel')} onPress={() => setOpen(false)} /></View>}
        <View style={{ flex: 2 }}>
          <AppButton label={asked ? t('relief.approve') : t('common.save')} icon="check" disabled={busy || !valid} loading={busy} testID="relief-approve"
                     onPress={() => run(() => asked
                       ? api(`/api/v1/owner/rent-relief/${asked.id}/decide`, { ownerAccount: owner, body: { action: 'approve', pay_amount: amount || '0', note: note.trim() || null } })
                       : api(`/api/v1/owner/tenancies/${tenancyId}/rent-relief`, { ownerAccount: owner, body: { period_month: month, pay_amount: amount || '0', note: note.trim() || null } }))} />
        </View>
      </View>
    </Panel>
  );
}
