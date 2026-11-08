// "How do you want to receive rent from this tenant?" Asked for every tenant: UPI direct (free), online checkout, or cash / bank transfer.
// A UPI ID the owner has not used before needs a one-time code (it is where the rent goes), so it is asked for here.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { Button } from '@/components/Buttons';
import { Chip2, ErrorBanner, Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { cleanUpi, upiValid } from '@/lib/upi';
import { brand, radius } from '@/theme';

export type PayMethod = 'upi' | 'online' | 'cash';
// custom = this tenant gets a UPI ID of its own instead of the one saved in the owner's profile
export type PayHowValue = { method: PayMethod | null; upi: string; otp: string; custom: boolean };
export const EMPTY_PAY_HOW: PayHowValue = { method: null, upi: '', otp: '', custom: false };

const OPTIONS: { value: PayMethod; icon: string; title: string; sub: string }[] = [
  { value: 'upi', icon: 'cellphone-check', title: 'payhow.upi', sub: 'payhow.upiSub' },
  { value: 'online', icon: 'credit-card-outline', title: 'payhow.online', sub: 'payhow.onlineSub' },
  { value: 'cash', icon: 'cash', title: 'payhow.cash', sub: 'payhow.cashSub' },
];

/** The owner's UPI IDs already approved with a code (the server keeps this list) and the one saved in the profile. */
export function useKnownUpi() {
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  return useQuery({ queryKey: ['upi-ids', owner], queryFn: () => api<{ upi_ids: string[]; default_upi_id: string | null; last_pay_method: PayMethod | null; online_available: boolean; default_pay_method: PayMethod | null }>('/api/v1/owner/upi-ids', { ownerAccount: owner }) });
}

/** A UPI ID has to be typed here when the profile has none yet, or when this tenant gets its own. */
const sendsId = (v: PayHowValue, def: string | null) => v.method === 'upi' && (v.custom || !def);
export const needsOtp = (v: PayHowValue, known: string[], def: string | null = null) => sendsId(v, def) && upiValid(v.upi) && !known.includes(cleanUpi(v.upi));

/** True when the choice can be sent: a method is picked and, for UPI, there is a valid ID (profile or typed) and (if new) the code. */
export function payHowReady(v: PayHowValue, known: string[], def: string | null = null): boolean {
  if (!v.method) return false;
  if (!sendsId(v, def)) return true;
  return upiValid(v.upi) && (!needsOtp(v, known, def) || otpReady(v.otp));
}

/** The fields to add to the request body. No UPI ID is sent when the tenant follows the profile one. */
export function payHowBody(v: PayHowValue, known: string[], def: string | null = null) {
  return { pay_method: v.method, pay_upi_id: sendsId(v, def) ? cleanUpi(v.upi) : null, otp_code: needsOtp(v, known, def) ? v.otp : null };
}

// scope 'default' = the owner's usual way for all tenants (Profile); 'tenant' = a choice for one tenant
export function PayHow({ value, onChange, showErrors, scope = 'tenant' }: { value: PayHowValue; onChange: (v: PayHowValue) => void; showErrors?: boolean; scope?: 'tenant' | 'default' }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const kq = useKnownUpi().data;
  const known = kq?.upi_ids ?? [];
  const def = kq?.default_upi_id ?? null;
  const onlineOk = !!kq?.online_available;      // online checkout needs a live payment provider; until then it cannot be chosen
  React.useEffect(() => { if (kq && !onlineOk && value.method === 'online') onChange({ ...value, method: null }); }, [kq, onlineOk, value.method]);   // online cannot stay selected while it is unavailable
  const upiErr = value.method === 'upi' && value.upi && !upiValid(value.upi) ? t('payhow.upiInvalid') : undefined;
  return (
    <Panel title={scope === 'default' ? t('payhow.defaultTitle') : t('payhow.title')} icon="wallet-outline" tone="amber">
      <Text style={{ color: brand.muted, lineHeight: 21 }}>{scope === 'default' ? t('payhow.defaultHint') : t('payhow.hint')}</Text>
      {OPTIONS.map((o) => {
        const off = o.value === 'online' && !onlineOk;
        const on = value.method === o.value && !off;
        return (
          <Pressable key={o.value} onPress={off ? undefined : () => onChange({ ...value, method: o.value })} disabled={off} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: off }} testID={`payhow-${o.value}`}
                     style={{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 12, borderRadius: radius.md, borderWidth: 1.5, opacity: off ? 0.55 : 1,
                              borderColor: on ? brand.teal700 : brand.line, backgroundColor: on ? brand.teal50 : '#fff' }}>
            <Icon source={on ? 'radiobox-marked' : 'radiobox-blank'} size={24} color={on ? brand.teal700 : brand.muted} />
            <Icon source={o.icon} size={24} color={on ? brand.teal700 : brand.muted} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: '800', color: on ? brand.teal700 : brand.ink }}>{t(o.title)}</Text>
              <Text variant="bodySmall" style={{ color: brand.muted, lineHeight: 18 }}>{off ? t('payhow.onlineSoon') : t(o.sub)}</Text>
            </View>
          </Pressable>
        );
      })}
      {showErrors && !value.method ? <Text style={{ color: '#B45309', fontWeight: '700' }}>{t('payhow.choose')}</Text> : null}
      {value.method === 'upi' ? (
        <View style={{ gap: 10 }}>
          {def && !value.custom ? (
            <>
              <View style={{ backgroundColor: brand.green100, borderRadius: radius.md, padding: 12, gap: 2 }}>
                <Text style={{ color: brand.muted, fontSize: 12, fontWeight: '700' }}>{t('payhow.useProfile')}</Text>
                <Text selectable style={{ fontWeight: '800', fontSize: 17, color: brand.green600 }} testID="payhow-profile-upi">{def}</Text>
              </View>
              {scope === 'tenant' ? <Button mode="text" icon="swap-horizontal" onPress={() => onChange({ ...value, custom: true, upi: '', otp: '' })} testID="payhow-use-other">{t('payhow.useOther')}</Button> : null}
            </>
          ) : (
            <>
              <Field label={t('payhow.upiId')} value={value.upi} onChangeText={(v) => onChange({ ...value, upi: v.replace(/\s/g, '').toLowerCase(), otp: '' })} testID="payhow-upi-id"
                     error={upiErr ?? (showErrors && !value.upi ? t('payhow.upiInvalid') : undefined)} />
              <Text variant="bodySmall" style={{ color: brand.muted }}>{def ? t('payhow.upiHelp') : t('payhow.saveHint')}</Text>
              {known.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {known.map((k) => <Chip2 key={k} icon="history" label={k} onPress={() => onChange({ ...value, upi: k, otp: '' })} />)}
                </View>
              ) : null}
              {def ? <Button mode="text" icon="account-check-outline" onPress={() => onChange({ ...value, custom: false, upi: '', otp: '' })} testID="payhow-use-mine">{t('payhow.useMine')}</Button> : null}
              {needsOtp(value, known, def) ? (
                <>
                  <Text style={{ color: '#B45309', fontWeight: '700', lineHeight: 20 }}>{t('payhow.upiNew')}</Text>
                  <ActionOtp action="payout" code={value.otp} onChange={(c) => onChange({ ...value, otp: c })} ownerAccount={owner} />
                </>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </Panel>
  );
}

/** The short name of a method, for lists and the tenant screen. */
export const payMethodLabel = (t: (k: string) => string, m: PayMethod | null | undefined) =>
  m === 'upi' ? t('payhow.upi') : m === 'online' ? t('payhow.online') : m === 'cash' ? t('payhow.cash') : t('payhow.notSet');

/** On a tenant's page: how this tenant pays now, with a way to change it. A tenant with no choice yet is flagged so the owner picks one. */
export function OwnerPayHow({ tenancyId, method, upi, active, effective }: { tenancyId: string; method: PayMethod | null | undefined; upi?: string | null; active: boolean; effective?: PayMethod | null }) {
  // `upi` is this tenant's own UPI ID (an override); without one the profile UPI ID is used
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const kq = useKnownUpi().data;
  const known = kq?.upi_ids ?? [];
  const def = kq?.default_upi_id ?? null;
  const [open, setOpen] = React.useState(false);
  const [v, setV] = React.useState<PayHowValue>(EMPTY_PAY_HOW);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<unknown>(null);
  const [touched, setTouched] = React.useState(false);
  const shown = method ?? effective ?? null;      // the tenant's own choice, or the owner's usual way
  const unset = !shown;

  async function save() {
    setTouched(true);
    if (!payHowReady(v, known, def)) return;
    setBusy(true); setErr(null);
    try {
      await api(`/api/v1/owner/tenancies/${tenancyId}/payment-method`, { method: 'PUT', ownerAccount: owner,
        body: { method: v.method, upi_id: payHowBody(v, known, def).pay_upi_id, otp_code: payHowBody(v, known, def).otp_code } });
      setOpen(false); setTouched(false);
      qc.invalidateQueries({ queryKey: ['tenancy', tenancyId] });
      qc.invalidateQueries({ queryKey: ['tenancies'] });
      qc.invalidateQueries({ queryKey: ['upi-ids'] });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <View style={{ gap: 12 }}>
      <Panel title={t('payhow.current')} icon="wallet-outline" tone={unset ? 'amber' : 'teal'}>
        <Text style={{ fontWeight: '800', fontSize: 16, color: unset ? '#B45309' : brand.ink }} testID="payhow-current">{payMethodLabel(t, shown)}</Text>
        {shown === 'upi' && (upi ?? def) ? <Text style={{ color: brand.muted }}>{upi ?? def}</Text> : null}
        {!method && effective ? <Text variant="bodySmall" style={{ color: brand.muted }}>{t('payhow.followsDefault')}</Text> : null}
        {unset && active ? <Text style={{ color: '#B45309', lineHeight: 21 }}>{t('payhow.setNow')}</Text> : null}
        {active ? (
          <Button mode="outlined" icon="pencil-outline" onPress={() => { setOpen(!open); setV({ method: shown, upi: upi ?? '', otp: '', custom: !!upi }); setErr(null); }} testID="payhow-change">
            {unset ? t('payhow.choose') : t('payhow.change')}
          </Button>
        ) : null}
      </Panel>
      {open ? (
        <>
          <PayHow value={v} onChange={setV} showErrors={touched} />
          <ErrorBanner error={err} />
          <Button mode="contained" icon="check" onPress={save} loading={busy} disabled={busy || !payHowReady(v, known, def)} testID="payhow-save">{t('common.save')}</Button>
        </>
      ) : null}
    </View>
  );
}
