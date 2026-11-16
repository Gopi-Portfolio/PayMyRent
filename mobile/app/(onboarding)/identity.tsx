// Identity verification (government ID + live selfie + name match) through the verification provider.
// RentMeezy shows only the outcome; the provider handles the ID and selfie.
import { NeedsInternet } from '@/components/NeedsInternet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { fmtDate } from '@/lib/dates';
import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Panel, ResultView, Screen, StatusPill } from '@/components/ui';
import { api, reachable } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { brand, radius } from '@/theme';

const STEPS = [
  { icon: 'card-account-details-outline', key: 'identity.step1', tone: brand.teal100, fg: brand.teal700 },
  { icon: 'face-recognition', key: 'identity.step2', tone: brand.blue100, fg: brand.blue600 },
  { icon: 'account-check-outline', key: 'identity.step3', tone: brand.green100, fg: brand.green600 },
] as const;

export default function Identity() {
  const { t } = useTranslation();
  const { refresh, mode } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['identity'], queryFn: () => api<any>('/api/v1/me/identity'),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : query.state.data?.status === 'manual_review' ? 15000 : false),
  });
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const d = q.data;
  const status: string = d?.status ?? 'none';
  // say exactly which check did not pass
  const reasons = [d?.liveness_passed === false && t('identity.reasonLiveness'), d?.face_matched === false && t('identity.reasonFace'),
                   d?.name_matched === false && t('identity.reasonName'), d?.review_note].filter(Boolean) as string[];

  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/api/v1/me/identity/start', { body: { consent, notice_version: d?.notice_version ?? 'kyc-v1', otp_code: code } });
      qc.setQueryData(['identity'], r);
      if (r.session?.url) await WebBrowser.openBrowserAsync(reachable(r.session.url));
      await api('/api/v1/me/identity/refresh', { method: 'POST' });
      await q.refetch(); await refresh();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function approveDemo() {
    setBusy(true); setErr(null);
    try { await api('/api/v1/me/identity/demo-approve', { method: 'POST' }); await q.refetch(); await refresh(); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true);
    try { await api('/api/v1/me/identity', { method: 'DELETE' }); await q.refetch(); await refresh(); setConsent(false); } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (status === 'verified') {
    return (
      <Screen>
        <NeedsInternet />
        <ResultView kind="success" title={t('identity.verified')} lines={d.expires_at ? [t('identity.valid', { date: fmtDate(String(d.expires_at)) })] : []}>
          <AppButton variant="outline" icon="account-off-outline" label={t('identity.withdraw')} onPress={withdraw} loading={busy} />
        </ResultView>
      </Screen>
    );
  }
  if (status === 'manual_review') {
    return (
      <Screen>
        <NeedsInternet />
        <ResultView kind="review" title={t('identity.manual_review')} hint={t('identity.reviewHint')} error={q.error} lines={reasons}>
          <AppButton icon="refresh" label={t('identity.check')} onPress={() => q.refetch()} />
          {mode === 'dev' ? <AppButton variant="accent" icon="account-check" label="Approve (Demo Reviewer)" onPress={approveDemo} loading={busy} /> : null}
          <AppButton variant="outline" icon="account-off-outline" label={t('identity.withdraw')} onPress={withdraw} />
        </ResultView>
      </Screen>
    );
  }
  if (status === 'pending') {
    return (
      <Screen>
        <NeedsInternet />
        <ResultView kind="pending" title={t('identity.pending')} error={q.error}
                    hint={t('identity.waitHint')} lines={reasons}>
          <AppButton icon="refresh" label={t('identity.check')} onPress={() => q.refetch()} />
          <AppButton variant="outline" icon="open-in-new" label={t('identity.openProvider')} onPress={() => start()} loading={busy} />
          <AppButton variant="outline" icon="account-off-outline" label={t('identity.withdraw')} onPress={withdraw} />
        </ResultView>
        <ErrorBanner error={err} />
      </Screen>
    );
  }
  return (
    <Screen>
      <NeedsInternet />
      <Text style={{ color: brand.muted }}>{t('identity.intro')}</Text>
      {status === 'failed' || status === 'rejected' ? (
        <Panel title={t(`identity.${status}`)} icon="alert-circle-outline" tone="red">
          {reasons.length ? reasons.map((r) => <Text key={r} style={{ color: brand.red600 }}>{`• ${r}`}</Text>) : null}
        </Panel>
      ) : null}
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
      <Panel>
        {STEPS.map((s, i) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: s.tone, alignItems: 'center', justifyContent: 'center' }}>
              <Icon source={s.icon} size={24} color={s.fg} />
            </View>
            <Text style={{ flex: 1, fontWeight: '600' }}>{`${i + 1}. ${t(s.key)}`}</Text>
          </View>
        ))}
      </Panel>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', backgroundColor: brand.teal50, borderRadius: radius.md, padding: 14 }}>
        <Icon source="shield-lock-outline" size={26} color={brand.teal700} />
        <Text variant="bodySmall" style={{ flex: 1, color: brand.teal900 }}>{t('identity.privacy')}</Text>
      </View>
      <Pressable onPress={() => setConsent(!consent)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }} testID="identity-consent"
                 style={({ pressed }) => [{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: radius.md, backgroundColor: pressed ? brand.teal100 : '#fff', borderWidth: 1, borderColor: brand.line }]}>
        <Icon source={consent ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={brand.teal700} />
        <Text style={{ flex: 1 }}>{t('identity.consent')}</Text>
      </Pressable>
      <ActionOtp action="identity" code={code} onChange={setCode} />
      <ErrorBanner error={err} />
      <AppButton icon="face-recognition" label={t('identity.start')} disabled={!consent || !otpReady(code)} loading={busy} onPress={start} testID="identity-start" />
    </Screen>
  );
}
