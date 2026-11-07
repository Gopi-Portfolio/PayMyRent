// Closing an owner account. Everything under the owner (places, renters) would be closed with it, so first ask: transfer it to someone else?
//   Yes → enter the new owner's mobile number (+ the code sent to this phone). The new owner takes over, but must pay for a plan before using it.
//   No  → close everything with the account.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { normalizeMobile } from '@/lib/format';
import { brand } from '@/theme';

type Step = 'ask' | 'transfer' | 'close';

export default function CloseOwnerAccount() {
  const { t } = useTranslation();
  const { me, signOut } = useAuth();
  const owner = ownerAccountId(me);
  const q = useQuery({ queryKey: ['close-preview', owner], queryFn: () => api<any>('/api/v1/owner/close-preview', { ownerAccount: owner }) });
  const [step, setStep] = useState<Step>('ask');
  const [handedTo, setHandedTo] = useState<string | null>(null);
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const renters = Number(q.data?.renters ?? 0);
  const places = Number(q.data?.places ?? 0);
  const phone = normalizeMobile(mobile);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); } };

  const transfer = () => run(async () => {
    await api('/api/v1/owner/transfer', { ownerAccount: owner, body: { phone: mobile, otp_code: code } });
    setHandedTo(mobile); setStep('close');
  });
  const close = () => run(async () => {
    await api('/api/v1/me/close-account', { body: { confirm, close_rentals: !handedTo && renters > 0 } });
    await signOut(); router.replace('/');
  });

  return (
    <Screen>
      <ErrorBanner error={err ?? q.error} onRetry={() => q.refetch()} />
      {step === 'ask' ? (
        <Panel tone="red" icon="account-switch-outline" title={t('closeOwner.askTitle')}>
          <Text style={{ lineHeight: 22 }}>{t('closeOwner.askBody', { renters, places })}</Text>
          <Text style={{ lineHeight: 22, fontWeight: '700' }}>{t('closeOwner.askQuestion')}</Text>
          {q.data && q.data.can_transfer === false ? <Text style={{ color: brand.muted }}>{t('closeOwner.mainOnly')}</Text> : null}
          <AppButton label={t('closeOwner.yes')} icon="account-arrow-right-outline" disabled={!q.data?.can_transfer} onPress={() => setStep('transfer')} testID="close-transfer-yes" />
          <AppButton variant="outline" label={t('closeOwner.no')} icon="close" onPress={() => setStep('close')} testID="close-transfer-no" />
        </Panel>
      ) : null}
      {step === 'transfer' ? (
        <>
          <Panel tone="teal" icon="account-arrow-right-outline" title={t('closeOwner.transferTitle')}>
            <Text style={{ lineHeight: 22 }}>{t('closeOwner.transferBody')}</Text>
            <Field label={t('closeOwner.newMobile')} value={mobile} onChangeText={setMobile} keyboardType="phone-pad" kind="mobile" testID="transfer-mobile" />
          </Panel>
          <ActionOtp action="transfer" code={code} onChange={setCode} ownerAccount={owner} />
          <AppButton label={t('closeOwner.transfer')} icon="check" loading={busy} disabled={busy || !phone || !otpReady(code)} onPress={transfer} testID="transfer-confirm" />
          <AppButton variant="outline" label={t('common.back')} onPress={() => setStep('ask')} />
        </>
      ) : null}
      {step === 'close' ? (
        <Panel tone="red" icon="account-remove-outline" title={t('privacy.close')}>
          {handedTo ? <Text style={{ lineHeight: 22, color: brand.teal700, fontWeight: '700' }}>{t('closeOwner.handed', { phone: handedTo })}</Text>
            : <Text style={{ lineHeight: 22 }}>{renters > 0 ? t('closeOwner.closeAll', { renters, places }) : t('privacy.closeWarn')}</Text>}
          <Field label={t('privacy.typeDelete')} value={confirm} onChangeText={setConfirm} kind="text" testID="close-confirm" />
          <AppButton label={t('privacy.close')} icon="account-remove-outline" loading={busy} disabled={busy || confirm.trim().toUpperCase() !== 'DELETE'} onPress={close} testID="close-final" />
        </Panel>
      ) : null}
    </Screen>
  );
}
