// Owners must fill these details before adding shops/houses or tenants. They can still switch to the Tenant role at any time.
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { SearchableSelect } from '@/components/SearchableSelect';
import { OwnerDocumentCheck, useOwnerDocs } from '@/components/OwnerDocumentCheck';
import { ErrorBanner, Field, Panel, Screen, StatusPill } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { addressSchema, nameSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

const PROOF_TYPES = ['property_tax', 'electricity_bill', 'sale_deed', 'rent_agreement', 'gst', 'other'];     // the label of each is ownerDetails.doc_<type>
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export default function OwnerDetails() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const owner = ownerAccountId(me);
  const docs = useOwnerDocs();     // when the server runs the automatic document check, this screen is replaced by it
  const existing = useQuery({ queryKey: ['owner-verification', owner], queryFn: () => api<any>('/api/v1/owner/verification', { ownerAccount: owner }) });
  const [f, setF] = useState({ legal_name: me?.full_name ?? '', pan: '', address: me?.address ?? '', proof_type: 'property_tax', proof_ref: '' });
  const [declare, setDeclare] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    const d = existing.data;
    if (d && d.status !== 'none') setF((x) => ({ ...x, legal_name: d.legal_name, address: d.address, proof_type: d.proof_type, proof_ref: d.proof_ref }));
  }, [existing.data]);

  const pan = f.pan.trim().toUpperCase();
  const e = {
    legal_name: nameSchema.safeParse(f.legal_name).success ? undefined : 'Enter your full name',
    pan: PAN.test(pan) ? undefined : 'PAN must look like ABCDE1234F',
    address: addressSchema.safeParse(f.address).success ? undefined : 'Enter your full address',
    proof_ref: f.proof_ref.trim().length >= 3 ? undefined : 'Enter the document number',
  };
  const ok = Object.values(e).every((x) => !x) && declare;
  const status = existing.data?.status;
  const [code, setCode] = useState('');

  async function submit() {
    setTouched(true);
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await api('/api/v1/owner/verification', { method: 'PUT', ownerAccount: owner, body: { ...f, pan, declare, otp_code: code } });
      await refresh();
      router.replace('/');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  if (docs.data?.enabled) return <OwnerDocumentCheck docs={docs.data} />;
  if (docs.isLoading) return <Screen><ActivityIndicator /></Screen>;

  return (
    <Screen>
      <Text style={{ color: brand.muted }}>{t('ownerDetails.subtitle')}</Text>
      {status && status !== 'none' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusPill status={status === 'submitted' ? 'pending' : status} />
          <Text>{t(`ownerDetails.${status}`)}{existing.data?.pan_masked ? ` · ${existing.data.pan_masked}` : ''}</Text>
        </View>
      ) : null}
      <Panel title={t('ownerDetails.title')} icon="account-check-outline">
        <Field label={t('ownerDetails.legalName')} value={f.legal_name} onChangeText={(v) => setF({ ...f, legal_name: v })} kind="name" error={touched ? e.legal_name : undefined} />
        <Field label={t('ownerDetails.pan')} value={f.pan} onChangeText={(v) => setF({ ...f, pan: v })} kind="pan"
               error={touched || f.pan.length === 10 ? e.pan : undefined} />
        <Field label={t('profile.address')} value={f.address} onChangeText={(v) => setF({ ...f, address: v })} kind="address" multiline error={touched ? e.address : undefined} />
      </Panel>
      <Panel title={t('ownerDetails.proofType')} icon="file-document-check-outline" tone="blue">
        <SearchableSelect label={t('ownerDetails.proofType')} value={f.proof_type} options={PROOF_TYPES.map((v) => ({ value: v, label: t(`ownerDetails.doc_${v}`) }))} onChange={(v) => setF({ ...f, proof_type: v })} />
        <Field label={t('ownerDetails.proofRef')} value={f.proof_ref} onChangeText={(v) => setF({ ...f, proof_ref: v })} maxLength={80} error={touched ? e.proof_ref : undefined} />
      </Panel>
      <Pressable onPress={() => setDeclare(!declare)} accessibilityRole="checkbox" accessibilityState={{ checked: declare }}
                 style={({ pressed }) => [{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: radius.md, backgroundColor: pressed ? brand.teal100 : brand.teal50 }]}>
        <Icon source={declare ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={brand.teal700} />
        <Text style={{ flex: 1 }}>{t('ownerDetails.declare')}</Text>
      </Pressable>
      <ErrorBanner error={err} />
      <ActionOtp action="owner_details" code={code} onChange={setCode} ownerAccount={owner} />
      <AppButton label={t('ownerDetails.submit')} icon="shield-check" disabled={(touched && !ok) || !otpReady(code)} loading={busy} onPress={submit} testID="owner-details-submit" />
    </Screen>
  );
}
