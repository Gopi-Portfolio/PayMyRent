// One choice for every tenant that has no way of receiving rent chosen yet (tenants added before this choice existed).
// Tenants who already have a choice are left alone, and any tenant can still be changed from their own page.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Buttons';
import { EMPTY_PAY_HOW, PayHow, type PayHowValue, payHowBody, payHowReady, useKnownUpi } from '@/components/PayHow';
import { ErrorBanner, Panel, ResultView, Screen, goBack } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { brand } from '@/theme';

export default function PaymentMethodForAll() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tenancies', owner, 'unset'], queryFn: () => api<any>('/api/v1/owner/tenancies?status=live', { ownerAccount: owner }) });
  const kq = useKnownUpi().data;
  const known = kq?.upi_ids ?? [];
  const def = kq?.default_upi_id ?? null;
  const count = (list.data?.items ?? []).filter((x: any) => !x.effective_pay_method).length;
  const [v, setV] = useState<PayHowValue>(EMPTY_PAY_HOW);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<number | null>(null);

  async function save() {
    setTouched(true);
    if (!payHowReady(v, known, def)) return;
    const b = payHowBody(v, known, def);
    setBusy(true); setErr(null);
    try {
      const r = await api<{ updated: number }>('/api/v1/owner/payment-method/unset', { method: 'PUT', ownerAccount: owner, body: { method: b.pay_method, upi_id: b.pay_upi_id, otp_code: b.otp_code } });
      qc.invalidateQueries();
      setDone(r.updated);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  if (done !== null) {
    return (
      <Screen>
        <ResultView kind="success" title={t('payhow.bulkDone', { count: done })}>
          <Button mode="contained" icon="check" onPress={() => goBack()} testID="bulk-done">{t('common.continue')}</Button>
        </ResultView>
      </Screen>
    );
  }
  return (
    <Screen>
      <Panel title={t('payhow.bulkTitle')} icon="account-multiple-check-outline" tone="amber">
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('payhow.bulkHint', { count })}</Text>
      </Panel>
      <PayHow value={v} onChange={setV} showErrors={touched} />
      <ErrorBanner error={err} />
      <Button mode="contained" icon="check-all" onPress={save} loading={busy} disabled={busy || count === 0 || !payHowReady(v, known, def)} testID="bulk-save">{t('payhow.bulkSave', { count })}</Button>
    </Screen>
  );
}
