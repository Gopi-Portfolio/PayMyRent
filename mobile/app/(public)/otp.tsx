import { Redirect, router } from 'expo-router';
import React, { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { sanitize } from '@/lib/inputs';
import { AppButton } from '@/components/Buttons';
import { AuthShell, DONE_ID, DoneBar, ErrorBanner, goBack } from '@/components/ui';
import { brand, radius } from '@/theme';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getPendingRole } from '@/lib/landing';
import { otpSession } from '@/lib/otpSession';

export default function Otp() {
  const [typing, setTyping] = React.useState(false);        // the code box is open for typing: show the tick that closes the keyboard
  const { t } = useTranslation();
  const { verifyOtp, requestOtp, signOut } = useAuth();
  const [note, setNote] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const s = otpSession.current;
  if (!s) return <Redirect href="/(public)/phone" />;   // navigating while rendering is not allowed; Redirect does it safely

  async function verify() {
    setBusy(true); setErr(null);
    try {
      await verifyOtp(s, code);
      // The Renter door lets in only a number an owner added (Add Renter) or invited. Asked after the code is verified, so a stranger's number cannot be probed.
      if (getPendingRole() === 'tenant') {
        let registered = false;
        try { registered = (await api<{ registered: boolean }>('/api/v1/me/renter-access')).registered; } catch { registered = false; }
        if (!registered) { await signOut(); setErr(new Error(t('auth.notRenter'))); return; }
      }
      otpSession.current = null;
      router.replace('/');
    } catch (e: any) {
      // a first-time owner who has not chosen a plan: no token was issued, so send them to choose one (the first month is free), then sign in again
      if (e?.code === 'PLAN_REQUIRED') { otpSession.current = null; router.replace({ pathname: '/(public)/plans', params: { first: '1' } }); return; }
      setErr(friendly(e));
    } finally { setBusy(false); }
  }

  /** Server messages are in English; show the reason in the user's language. */
  function friendly(e: any) {
    const m = String(e?.message ?? '').toLowerCase();
    if (e?.code === 'VALIDATION' && m.includes('incorrect')) return new Error(t('error.otp_incorrect'));
    if (e?.code === 'VALIDATION' && (m.includes('expired') || m.includes('attempts'))) return new Error(t('error.otp_expired'));
    if (e?.code === 'RATE_LIMITED') return new Error(t('error.otp_rate'));
    return e;
  }

  async function resend() {
    setBusy(true); setErr(null); setNote(null);
    try {
      otpSession.current = await requestOtp(s.phoneE164);
      setCode(''); setNote(t('auth.resent'));
    } catch (e) { setErr(friendly(e)); } finally { setBusy(false); }
  }

  return (
    <AuthShell title={t('auth.verify')} subtitle={t('auth.enterOtp', { phone: s.phoneE164.replace('+91', '+91 ') })}>
      {s.demoCode ? (
        <View style={{ backgroundColor: brand.amber100, borderRadius: radius.md, padding: 12 }}>
          <Text testID="demo-code" style={{ color: '#92400E', fontWeight: '700', textAlign: 'center' }}>{t('auth.demoCode', { code: s.demoCode })}</Text>
        </View>
      ) : null}
      <TextInput mode="outlined" outlineStyle={{ borderRadius: radius.md }} style={{ backgroundColor: '#fff', fontSize: 26, letterSpacing: 10, textAlign: 'center', height: 64 }} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6}
                 value={code} onChangeText={(v) => { const c = sanitize('otp', v); setCode(c); if (c.length === 6) Keyboard.dismiss(); }}   // the six digits are in: the keyboard closes by itself
                 inputAccessoryViewID={DONE_ID} accessibilityLabel="OTP" testID="otp-input"
                 onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
                 right={typing ? <TextInput.Icon icon="check-circle" onPress={() => Keyboard.dismiss()} accessibilityLabel={t('common.done')} testID="otp-input-done" /> : undefined} />
      <DoneBar />
      <ErrorBanner error={err} />
      {note ? <Text style={{ color: brand.green600, fontWeight: '700', textAlign: 'center' }}>{note}</Text> : null}
      <AppButton label={t('auth.verify')} icon="check-decagram" disabled={code.length !== 6} loading={busy} onPress={verify} />
      <AppButton variant="outline" label={t('auth.resend')} icon="message-text-outline" disabled={busy} onPress={resend} />
      <AppButton variant="outline" label={t('common.back')} icon="arrow-left" disabled={busy} onPress={goBack} testID="back-below" />
    </AuthShell>
  );
}
