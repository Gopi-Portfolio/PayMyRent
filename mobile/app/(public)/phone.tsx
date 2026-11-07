import { router } from 'expo-router';
import React, { useState } from 'react';
import { Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { sanitize } from '@/lib/inputs';
import { AppButton } from '@/components/Buttons';
import { AuthShell, ErrorBanner, goBack } from '@/components/ui';
import { radius } from '@/theme';
import { useAuth } from '@/lib/auth';
import { normalizeMobile } from '@/lib/format';
import { otpSession } from '@/lib/otpSession';

export default function Phone() {
  const { t } = useTranslation();
  const { requestOtp } = useAuth();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const e164 = normalizeMobile(raw);

  async function send() {
    if (!e164) return;
    setBusy(true); setErr(null);
    try {
      otpSession.current = await requestOtp(e164);
      router.push('/(public)/otp');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <AuthShell title={t('auth.enterMobile')} subtitle={t('app.tagline')}>
      <TextInput mode="outlined" outlineStyle={{ borderRadius: radius.md }} style={{ backgroundColor: '#fff', fontSize: 18, height: 60 }} left={<TextInput.Affix text="+91" />} keyboardType="phone-pad" textContentType="telephoneNumber"
                 autoComplete="tel" value={raw} onChangeText={(v) => setRaw(sanitize('mobile', v))} maxLength={14}
                 error={raw.length === 10 && !e164} accessibilityLabel={t('auth.enterMobile')} testID="phone-input" />
      {raw.length === 10 && !e164 ? <Text style={{ color: 'crimson' }}>{t('error.mobile_10_digits')}</Text> : null}
      <ErrorBanner error={err} />
      <AppButton label={t('auth.sendOtp')} icon="send" disabled={!e164} loading={busy} onPress={send} />
      <AppButton variant="outline" label={t('common.back')} icon="arrow-left" disabled={busy} onPress={goBack} testID="back-below" />
    </AuthShell>
  );
}
