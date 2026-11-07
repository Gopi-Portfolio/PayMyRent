import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, ResultView, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { getPropertyDraft } from '@/lib/propertyDraft';

export default function PaymentStatus() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const q = useQuery({
    queryKey: ['sub-order', orderId],
    queryFn: () => api<any>(`/api/v1/subscription/orders/${orderId}/refresh`, { method: 'POST', ownerAccount: ownerAccountId(me) }),
    refetchInterval: (query) => (query.state.data?.order.status === 'created' ? 3000 : false),
  });
  const status = q.data?.order.status;
  const [ready, setReady] = useState(false);          // the app knows the plan is active before it moves on
  const [next, setNext] = useState<string>('/(app)/owner');
  useEffect(() => {
    if (status !== 'paid') return;
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'sub-order' });          // plan, dashboard and banners re-read the new state
    refresh().then((m) => {
      // a paid plan whose property has not been filled in yet: go straight to the property form (what was typed before paying is still there)
      const o = m?.owner_accounts.find((a) => a.owner_account_id === ownerAccountId(m));
      if (getPropertyDraft() || (o && !o.property_status)) setNext('/(app)/owner/add-property');
      setReady(true);
    }).catch(() => setReady(true));
  }, [status, refresh]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Screen>
      {status === 'paid' ? (
        <ResultView kind="success" title={t('pay.success')}>
          <AppButton label={next.includes('add-property') ? t('property.fillNow') : t('common.continue')} icon="arrow-right-circle" loading={!ready} disabled={!ready}
                     onPress={() => router.replace(next as any)} testID="after-payment" />
        </ResultView>
      ) : status === 'failed' || status === 'expired' ? (
        <ResultView kind="failed" title={t('pay.failed')}>
          <AppButton label={t('common.retry')} icon="refresh" onPress={() => router.replace('/(onboarding)/plan')} />
        </ResultView>
      ) : (
        <ResultView kind="pending" title={t('pay.pending')} hint={t('pay.waitHint')} error={q.error}>
          <AppButton variant="outline" icon="refresh" label={t('identity.check')} onPress={() => q.refetch()} />
        </ResultView>
      )}
      <ErrorBanner error={q.error} onRetry={() => q.refetch()} />
    </Screen>
  );
}
