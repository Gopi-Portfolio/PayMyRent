import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, Text, TextInput } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { sanitize } from '@/lib/inputs';
import { AppButton } from '@/components/Buttons';
import { Keyboard } from 'react-native';
import { AuthShell, DONE_ID, DoneBar, ErrorBanner, Field, goBack, useDoneTick, type Plan } from '@/components/ui';
import { api } from '@/lib/api';
import { brand, radius } from '@/theme';
import { useAuth } from '@/lib/auth';
import { getPendingName, getPendingPlan, setPendingName, usePendingRole } from '@/lib/landing';
import { nameSchema } from '@/lib/validation';
import { normalizeMobile } from '@/lib/format';
import { otpSession } from '@/lib/otpSession';

/** What the visitor picked on the landing page, shown above the sign-in form: the plan (name, price, what it includes), or the role. */
function Choice({ door }: { door: 'owner' | 'tenant' | null }) {
  const { t } = useTranslation();
  const code = getPendingPlan();
  const plansQ = useQuery({ queryKey: ['plans'], queryFn: () => api<{ plans: Plan[] }>('/api/v1/plans', { auth: false }), enabled: !!code });
  const plan = code ? plansQ.data?.plans.find((p) => p.code === code) : undefined;
  if (plan) {
    return (
      <View style={{ backgroundColor: brand.teal50, borderRadius: radius.lg, borderWidth: 2, borderColor: brand.teal700, paddingVertical: 12, paddingHorizontal: 14, gap: 4 }} testID="chosen-plan">
        <Text style={{ color: brand.teal700, fontWeight: '800', fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase' }}>{t('auth.yourPlan')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <Text style={{ color: '#000', fontSize: 20, fontWeight: '800' }}>{t(`pricing.name_${plan.code}`, { defaultValue: plan.label })}</Text>
          <Text style={{ color: brand.teal700, fontSize: 22, fontWeight: '800' }}>{plan.price_display}<Text style={{ color: brand.muted, fontSize: 13, fontWeight: '500' }}> {t('pricing.perMonth')}</Text></Text>
        </View>
        <Text style={{ color: brand.green600, fontWeight: '800' }}>{t('pricing.firstMonthFree')}</Text>
      </View>
    );
  }
  if (!door) return null;
  const owner = door === 'owner';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: brand.teal50, borderRadius: radius.lg, padding: 14 }} testID="chosen-role">
      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: brand.teal700, alignItems: 'center', justifyContent: 'center' }}>
        <Icon source={owner ? 'office-building-outline' : 'key-variant'} size={24} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#000', fontSize: 17, fontWeight: '800' }}>{t(owner ? 'welcome.ownerTitle' : 'welcome.renterTitle')}</Text>
        <Text style={{ color: brand.muted }}>{t(owner ? 'welcome.ownerSub' : 'welcome.renterSub')}</Text>
      </View>
    </View>
  );
}

export default function Phone() {
  const { t } = useTranslation();
  const { requestOtp } = useAuth();
  const [name, setName] = useState(getPendingName());
  const [raw, setRaw] = useState('');
  const phoneDone = useDoneTick('phone-input');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const e164 = normalizeMobile(raw);
  const nameCheck = nameSchema.safeParse(name);
  const door = usePendingRole();      // owners (and anyone who tapped a plan) are told what going back means

  async function send() {
    if (!e164 || !nameCheck.success) return;
    setPendingName(name.trim());
    setBusy(true); setErr(null);
    try {
      otpSession.current = await requestOtp(e164);
      router.push('/(public)/otp');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <AuthShell title={t('auth.signInMobile')} subtitle={t('app.tagline')} note={door === 'owner' ? t('pricing.noPlanNote') : undefined}>
      <Choice door={door} />
      <Field label={t('profile.fullName')} value={name} onChangeText={setName} kind="name"
             error={name && !nameCheck.success ? nameCheck.error.issues[0].message : undefined} testID="name-input" />
      <TextInput mode="outlined" {...phoneDone} label={t('auth.mobileNumber')} outlineStyle={{ borderRadius: radius.md }} style={{ backgroundColor: '#fff', fontSize: 18, height: 60 }} left={<TextInput.Affix text="+91" />} keyboardType="phone-pad" textContentType="telephoneNumber"
                 autoComplete="tel" value={raw} onChangeText={(v) => { const m = sanitize('mobile', v); setRaw(m); if (m.length === 10) Keyboard.dismiss(); }} inputAccessoryViewID={DONE_ID} maxLength={14}
                 error={raw.length === 10 && !e164} accessibilityLabel={t('auth.enterMobile')} testID="phone-input" />
      <DoneBar />
      {raw.length === 10 && !e164 ? <Text style={{ color: 'crimson' }}>{t('error.mobile_10_digits')}</Text> : null}
      <ErrorBanner error={err} />
      <AppButton label={t('auth.sendOtp')} icon="send" disabled={!e164 || !nameCheck.success} loading={busy} onPress={send} />
      <AppButton variant="outline" label={t('common.back')} icon="arrow-left" disabled={busy} onPress={goBack} testID="back-below" />
    </AuthShell>
  );
}
