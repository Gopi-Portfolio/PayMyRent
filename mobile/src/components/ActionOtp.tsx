// The one-time code that approves a verification step. It is always sent to the mobile number attached to this account
// (the app never lets the user type a destination), and it is good for this one step only.
import React, { useState } from 'react';
import { Keyboard, View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { actionCodesRequired } from '@/lib/actionCodes';
import { brand } from '@/theme';

export type OtpAction = 'identity' | 'owner_details' | 'property' | 'payout' | 'co_owner' | 'transfer';
/** With the extra codes switched off on the server (the test server), a step is "ready" without a code. */
export const otpReady = (code: string) => !actionCodesRequired() || /^\d{6}$/.test(code);

export function ActionOtp({ action, code, onChange, ownerAccount }: { action: OtpAction; code: string; onChange: (c: string) => void; ownerAccount?: string | null }) {
  const { t } = useTranslation();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [demo, setDemo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setBusy(true); setErr(null);
    try {
      const r = await api<any>('/api/v1/me/action-otp/request', { body: { action }, ownerAccount: ownerAccount ?? undefined });
      setSentTo(r.sent_to); setDemo(r.demo_code ?? null); onChange('');
    } catch (e: any) { setErr(e?.message ?? t('common.retry')); } finally { setBusy(false); }
  }

  if (!actionCodesRequired()) return null;       // no extra code on this server: the login code is the only one
  return (
    <Panel title={t('otp.title')} icon="message-lock-outline" tone="blue">
      <Text style={{ color: brand.muted, lineHeight: 21 }}>{sentTo ? t('otp.sentTo', { phone: sentTo }) : t('otp.explain')}</Text>
      {sentTo ? (
        <View style={{ gap: 6 }}>
          <Field label={t('otp.code')} value={code} onChangeText={(v) => { const c = v.replace(/\D/g, '').slice(0, 6); onChange(c); if (c.length === 6) Keyboard.dismiss(); }} keyboardType="number-pad" maxLength={6} testID={`otp-${action}`} />
          {demo ? <Text variant="bodySmall" style={{ color: '#B45309' }}>{t('otp.demo', { code: demo })}</Text> : null}
        </View>
      ) : null}
      {err ? <Text style={{ color: '#B42318' }}>{err}</Text> : null}
      <AppButton variant="outline" icon="message-processing-outline" label={sentTo ? t('otp.resend') : t('otp.send')} loading={busy} onPress={send} testID={`otp-send-${action}`} />
    </Panel>
  );
}
