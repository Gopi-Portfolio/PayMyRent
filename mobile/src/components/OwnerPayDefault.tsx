// "How I usually receive rent", saved once in the profile. Every tenant follows it unless the owner chose something else for that tenant.
import { useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Buttons';
import { EMPTY_PAY_HOW, PayHow, type PayHowValue, payHowBody, payHowReady, payMethodLabel, useKnownUpi } from '@/components/PayHow';
import { ErrorBanner } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export function OwnerPayDefault() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const canEdit = me?.owner_accounts.find((o) => o.owner_account_id === owner)?.role === 'owner';
  const qc = useQueryClient();
  const q = useKnownUpi().data;
  const known = q?.upi_ids ?? [];
  const def = q?.default_upi_id ?? null;
  const current = q?.default_pay_method ?? null;
  const [v, setV] = useState<PayHowValue>(EMPTY_PAY_HOW);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // show the saved choice once it has loaded; the owner can then pick another
  React.useEffect(() => { if (current) setV((x) => (x.method ? x : { ...x, method: current })); }, [current]);
  const changed = v.method !== current;

  async function save() {
    setTouched(true);
    if (!payHowReady(v, known, def)) return;
    const b = payHowBody(v, known, def);
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api('/api/v1/owner/pay-default', { method: 'PUT', ownerAccount: owner, body: { method: b.pay_method, upi_id: b.pay_upi_id, otp_code: b.otp_code } });
      setSaved(true); setTouched(false);
      qc.invalidateQueries();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (!canEdit) return null;       // only the account owner decides how rent is received
  return (
    <View style={{ gap: 12 }}>
      <PayHow value={v} onChange={(x) => { setV(x); setSaved(false); }} showErrors={touched} scope="default" />
      <Text style={{ color: brand.muted }} testID="pay-default-current">{`${t('payhow.current')}: ${payMethodLabel(t, current)}`}</Text>
      <ErrorBanner error={err} />
      {saved ? <Text style={{ color: brand.green600, fontWeight: '700' }} testID="pay-default-saved">{t('payhow.defaultSaved')}</Text> : null}
      <Button mode="contained" icon="check" onPress={save} loading={busy} disabled={busy || !changed || !payHowReady(v, known, def)} testID="pay-default-save">{t('common.save')}</Button>
    </View>
  );
}
