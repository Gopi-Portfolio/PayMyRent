// Owner numbers: who may act as an owner of this account. Up to 2 people in total (you + one more), identified by mobile number.
// Only someone who signs in with the number entered here becomes a co-owner; nobody else can see these properties.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { RelationshipPicker, Relationship } from '@/components/RelationshipPicker';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { normalizeMobile } from '@/lib/format';
import { brand } from '@/theme';

export default function OwnerNumbers() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['owner-numbers', owner], queryFn: () => api<any>('/api/v1/owner/owner-numbers', { ownerAccount: owner }) });
  const [mobile, setMobile] = useState('');
  const [rel, setRel] = useState<Relationship | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const save = async (coOwners: { phone: string; relationship: Relationship }[]) => {
    setErr(null); setBusy(true);
    try {
      const r = await api<any>('/api/v1/owner/owner-numbers', { method: 'PUT', ownerAccount: owner, body: { co_owners: coOwners, otp_code: code } });
      qc.setQueryData(['owner-numbers', owner], r); setMobile(''); setRel(null); setCode('');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const bad = !!mobile && !normalizeMobile(mobile);
  return (
    <Screen>
      <Text style={{ color: brand.muted, lineHeight: 22 }}>{t('ownerNumbers.intro', { count: d?.max ?? 2 })}</Text>
      <ErrorBanner error={err ?? q.error} />
      <Panel title={t('ownerNumbers.owners')} icon="account-key-outline" tone="teal">
        {(d?.owners ?? []).map((o: any) => (
          <View key={o.phone ?? o.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
            <Icon source={o.role === 'owner' ? 'shield-account' : 'account-multiple'} size={22} color={brand.teal700} />
            <Text style={{ flex: 1, fontWeight: '700' }}>{`${o.name ?? ''} · ${o.phone ?? ''}`}</Text>
            <Text style={{ color: brand.muted }}>{o.role === 'owner' ? t('ownerNumbers.main') : t('ownerNumbers.coOwner')}</Text>
          </View>
        ))}
        {(d?.declared ?? []).filter((x: any) => !x.joined).map((x: any) => (
          <View key={x.phone} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
            <Icon source="clock-outline" size={22} color={brand.amber700} />
            <Text style={{ flex: 1, fontWeight: '700' }}>{`${x.phone} · ${t(`ownerNumbers.rel_${x.relationship}`)}`}</Text>
            <Text style={{ color: brand.amber700 }}>{t('ownerNumbers.waiting')}</Text>
          </View>
        ))}
      </Panel>
      {d?.can_edit && (((d?.declared ?? []).length > 0) || d?.slots_left > 0) ? <ActionOtp action="co_owner" code={code} onChange={setCode} ownerAccount={owner} /> : null}
      {d?.can_edit ? (
        (d?.declared ?? []).length > 0 ? (
          <AppButton variant="outline" icon="account-remove-outline" label={t('ownerNumbers.remove')} loading={busy} disabled={!otpReady(code)} onPress={() => save([])} />
        ) : d?.slots_left > 0 ? (
          <Panel title={t('ownerNumbers.add')} icon="account-plus-outline" tone="green">
            <Field label={t('ownerNumbers.mobile')} value={mobile} onChangeText={setMobile} keyboardType="phone-pad" kind="mobile" />
            <RelationshipPicker value={rel} onChange={setRel} />
            <AppButton label={t('ownerNumbers.save')} icon="check" loading={busy} disabled={!mobile || bad || !rel || !otpReady(code)} onPress={() => save([{ phone: mobile, relationship: rel! }])} />
          </Panel>
        ) : null
      ) : (
        <Text style={{ color: brand.muted }}>{t('ownerNumbers.mainOnly')}</Text>
      )}
    </Screen>
  );
}
