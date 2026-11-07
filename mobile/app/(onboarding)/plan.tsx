// Owner activation: choose plan → server creates PSP order (price is server-side) → hosted checkout
// → back to a "confirming" screen that polls the server. Never activates on the client callback.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useRef, useState } from 'react';
import { Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { RelationshipPicker, Relationship } from '@/components/RelationshipPicker';
import { ErrorBanner, Field, PricingCards, Screen } from '@/components/ui';
import { api, newIdempotencyKey, reachable } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/dates';
import { getPendingPlan, setPendingPlan } from '@/lib/landing';

export default function Plan() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const sub = useQuery({ queryKey: ['subscription', owner], enabled: !!owner && !!me?.profile_complete, queryFn: () => api<any>('/api/v1/subscription', { ownerAccount: owner }) });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api<{ plans: any[] }>('/api/v1/plans', { auth: false }) });
  const [scheduled, setScheduled] = useState<{ plan: string; date: string } | null>(null);
  const [plan, setPlan] = useState<string | null>(getPendingPlan() ?? 'growth');   // the plan tapped on the landing page, if any
  const [busy, setBusy] = useState(false);
  const [ownerMobile, setOwnerMobile] = useState('');
  const [ownerRel, setOwnerRel] = useState<Relationship | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const idem = useRef(newIdempotencyKey());     // same key on retry → same order, no double charge

  // what Continue will do: first plan / upgrade = pay now, same plan = renew, smaller plan = scheduled for the next renewal (no payment)
  const cur = sub.data?.current;
  const chosen = plans.data?.plans.find((p) => p.code === plan);
  const mode: 'pay' | 'renew' | 'downgrade' = !cur || !chosen ? 'pay' : cur.plan_code === plan ? 'renew' : chosen.max_units < cur.max_units ? 'downgrade' : 'pay';

  async function pay() {
    if (!plan) return;
    setBusy(true); setErr(null);
    try {
      setPendingPlan(null);
      if (mode === 'downgrade') {
        const r = await api<any>('/api/v1/subscription/change-plan', { ownerAccount: owner, body: { plan_code: plan, idempotency_key: idem.current } });
        setScheduled({ plan: chosen?.label ?? plan, date: fmtDate(String(r.current?.period_end ?? cur?.period_end ?? '')) });
        return;
      }
      const extra = ownerMobile.trim() && ownerRel ? [{ phone: ownerMobile.trim(), relationship: ownerRel }] : undefined;   // the second owner (number + relationship), declared when buying
      const order = await api<any>('/api/v1/subscription/checkout', { ownerAccount: owner, body: { plan_code: plan, idempotency_key: idem.current, co_owners: extra, otp_code: extra ? code : undefined } });
      if (order.status !== 'paid') {
        if (order.checkout?.pay_url) await WebBrowser.openBrowserAsync(reachable(order.checkout.pay_url));
        // Razorpay: open the native checkout SDK with order.checkout (key_id, order_id) here.
      }
      router.replace({ pathname: '/(onboarding)/payment-status', params: { orderId: order.order_id } });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <PricingCards selected={plan} onSelect={setPlan} />
      <ErrorBanner error={err} />
      {scheduled ? (
        <>
          <Text variant="bodyLarge" style={{ fontWeight: '700' }}>{t('pricing.scheduled', { plan: scheduled.plan, date: scheduled.date })}</Text>
          <AppButton label={t('pricing.done')} icon="check" onPress={() => router.back()} />
        </>
      ) : (
        <>
        {mode !== 'downgrade' && !cur ? <Field label={t('ownerNumbers.optional')} value={ownerMobile} onChangeText={setOwnerMobile} keyboardType="phone-pad" kind="mobile" /> : null}
        {mode !== 'downgrade' && !cur && ownerMobile.trim() ? <RelationshipPicker value={ownerRel} onChange={setOwnerRel} /> : null}
        {mode !== 'downgrade' && !cur && ownerMobile.trim() && ownerRel ? <ActionOtp action="co_owner" code={code} onChange={setCode} /> : null}
        <AppButton label={mode === 'downgrade' ? t('pricing.scheduleChange') : mode === 'renew' ? t('pricing.renewPlan') : cur ? t('pricing.payUpgrade') : t('common.continue')}
                   icon={mode === 'downgrade' ? 'calendar-clock' : 'credit-card-check-outline'} disabled={!plan || (mode !== 'downgrade' && !cur && !!ownerMobile.trim() && (!ownerRel || !otpReady(code)))} loading={busy} onPress={pay} testID="plan-pay" />
        </>
      )}
      {me?.roles.includes('tenant') ? (
        <AppButton variant="outline" label={t('role.switchTenant')} icon="home" onPress={() => router.replace('/(app)/tenant')} />
      ) : null}
      <Text variant="bodySmall">{t('pricing.paidByOwner')}</Text>
    </Screen>
  );
}
