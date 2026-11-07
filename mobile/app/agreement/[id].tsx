// The agreement for one rental, for the owner and the renter. The yearly increase is shown as read-only labels (it comes from the rental's terms);
// the owner picks the new end date to renew. Renewing while it runs is an Extension, after it lapsed a New Agreement. Every agreement stays in the history.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { dmyToIso, fmtDate, fmtMonth } from '@/lib/dates';
import { brand, radius } from '@/theme';

const dmy = (iso: string | null | undefined) => fmtDate(iso);
const plusOneYear = (iso: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}-${m[2]}-${Number(m[1]) + 1}` : '';
};

function Label({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'warn' | 'good' }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 }}>
      <Text style={{ flex: 1, color: brand.muted, fontWeight: '600' }}>{k}</Text>
      <Text style={{ fontWeight: strong ? '800' : '700', color: tone === 'warn' ? '#B45309' : tone === 'good' ? brand.green600 : brand.ink, fontVariant: ['tabular-nums'] }}>{v}</Text>
    </View>
  );
}

export default function Agreement() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agreement', id], queryFn: () => api<any>(`/api/v1/tenancies/${id}/agreement`) });
  const a = q.data;
  const [endText, setEndText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  React.useEffect(() => { if (a && !endText) setEndText(plusOneYear(a.end_date)); }, [a?.end_date]);   // eslint-disable-line react-hooks/exhaustive-deps

  const iso = dmyToIso(endText);
  const valid = !!iso && !!a?.end_date && iso > a.end_date && iso > new Date().toISOString().slice(0, 10);
  async function renew() {
    setBusy(true); setErr(null); setDone(null);
    try {
      const out = await api<any>(`/api/v1/owner/tenancies/${id}/agreement/renew`, { ownerAccount: a.owner_account_id, body: { new_end_date: iso, note: note.trim() || null } });
      setDone(out.renewed_as);
      qc.setQueryData(['agreement', id], out);
      ['notifications', 'tenancy', 'bill', 'rentals', 'tenancies', 'dash'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const state = a?.state as string | undefined;
  const banner = state === 'lapsed' ? { tone: 'red' as const, icon: 'alert-circle-outline', text: t('agreement.lapsedText', { date: dmy(a?.end_date) }) }
    : state === 'ending_soon' ? { tone: 'amber' as const, icon: 'clock-alert-outline', text: t('agreement.endingText', { date: dmy(a?.end_date), days: a?.days_left }) }
    : state === 'open' ? { tone: 'teal' as const, icon: 'infinity', text: t('agreement.openText') }
    : state ? { tone: 'teal' as const, icon: 'check-circle-outline', text: t('agreement.runningText', { date: dmy(a?.end_date), days: a?.days_left }) } : null;

  return (
    <Screen>
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      {a ? (
        <>
          <Panel tone={banner?.tone ?? 'teal'} icon={banner?.icon} title={`${a.unit}${a.renter_name && a.viewer_role === 'owner' ? ` · ${a.renter_name}` : ''}`}>
            <Text testID="agreement-status" style={{ fontWeight: '700' }}>{banner?.text}</Text>
            <View style={{ height: 8 }} />
            <Label k={t('agreement.startedOn')} v={dmy(a.start_date)} />
            <Label k={t('agreement.endsOn')} v={a.end_date ? dmy(a.end_date) : '—'} strong />
          </Panel>

          {a.end_date ? (
            <Panel icon="trending-up" title={t('agreement.rentTitle')} tone="amber">
              <Label k={t('agreement.currentRent')} v={a.current_rent_display} />
              {a.increment_percent && Number(a.increment_percent) > 0 ? (
                <>
                  <Label k={t('agreement.increase', { pct: Number(a.increment_percent) })} v={`+ ${a.increment_display}`} tone="warn" />
                  <Label k={t('agreement.newRent', { month: a.new_rent_from ? fmtMonth(a.new_rent_from) : '' })} v={a.new_rent_display} strong />
                </>
              ) : <Text variant="bodySmall" style={{ color: brand.muted }}>{t('agreement.noIncrease')}</Text>}
            </Panel>
          ) : null}

          {a.can_renew ? (
            <Panel icon="file-sign" title={t('agreement.renewTitle')} tone="teal">
              <View style={{ alignSelf: 'flex-start', backgroundColor: a.will_be === 'new' ? brand.red100 : brand.green100, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8 }}>
                <Text style={{ fontWeight: '800', fontSize: 12, color: a.will_be === 'new' ? brand.red600 : brand.green600 }} testID="will-be">
                  {t(a.will_be === 'new' ? 'agreement.willBeNew' : 'agreement.willBeExtension')}
                </Text>
              </View>
              <Text variant="bodySmall" style={{ color: brand.muted, marginBottom: 8 }}>{t(a.will_be === 'new' ? 'agreement.newHelp' : 'agreement.extensionHelp', { date: dmy(a.new_start_date) })}</Text>
              <Field label={t('agreement.newEnd')} value={endText} onChangeText={setEndText} kind="date" testID="new-end-date"
                     error={endText && !valid ? 'date_invalid' : undefined} />
              <Field label={t('agreement.note')} value={note} onChangeText={setNote} kind="reason" />
              {done ? <Text style={{ color: brand.green600, fontWeight: '700', marginBottom: 6 }} testID="renewed-ok">{t(done === 'new' ? 'agreement.savedNew' : 'agreement.savedExtension')}</Text> : null}
              <ErrorBanner error={err} />
              <AppButton label={t('agreement.renew')} icon="check" disabled={!valid || busy} loading={busy} onPress={renew} testID="renew" />
            </Panel>
          ) : a.viewer_role === 'tenant' && state && state !== 'running' && state !== 'open' ? (
            <Panel icon="information-outline" title={t('agreement.renewTitle')} tone="blue">
              <Text>{t('agreement.askOwner')}</Text>
            </Panel>
          ) : null}

          <Panel icon="history" title={t('agreement.history')} tone="blue">
            {a.history.map((h: any) => (
              <View key={h.seq} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: brand.line, gap: 2 }} testID={`history-${h.seq}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ backgroundColor: brand.teal50, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ fontWeight: '800', fontSize: 11, color: brand.teal700 }}>{`#${h.seq} · ${t(`agreement.kind_${h.kind}`)}`}</Text>
                  </View>
                  <Text style={{ flex: 1, textAlign: 'right', fontWeight: '800', fontVariant: ['tabular-nums'] }}>{h.monthly_rent_display}</Text>
                </View>
                <Text variant="bodySmall" style={{ color: brand.muted }}>{`${dmy(h.start_date)} → ${h.end_date ? dmy(h.end_date) : '—'}${h.increment_percent && Number(h.increment_percent) > 0 ? ` · +${Number(h.increment_percent)}%` : ''}`}</Text>
                {h.note ? <Text variant="bodySmall" style={{ color: brand.muted }}>{h.note}</Text> : null}
              </View>
            ))}
          </Panel>
        </>
      ) : q.isLoading ? <Icon source="timer-sand" size={28} color={brand.muted} /> : null}
    </Screen>
  );
}
