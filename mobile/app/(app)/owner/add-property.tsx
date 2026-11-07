// Add a property. Everything is checked before any money is asked for: the details, the ownership proof, and whether the property is already
// registered by someone else. The first property goes into this account; ANOTHER property becomes its own account with its own plan and payment.
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ActionOtp, otpReady } from '@/components/ActionOtp';
import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Field, Panel, Screen, TabPills, goBack } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { PropertyDraft, getPropertyDraft, setPropertyDraft } from '@/lib/propertyDraft';
import { brand } from '@/theme';

const EMPTY: PropertyDraft = { name: '', address: '', city: '', state: '', pincode: '', kind: 'commercial', proofType: 'property_tax', proofRef: '', declare: false };

export default function AddProperty() {
  const { t } = useTranslation();
  const { me, refresh, selectOwner } = useAuth();
  const qc = useQueryClient();
  const owner = ownerAccountId(me);
  const acct = me?.owner_accounts.find((o) => o.owner_account_id === owner);
  const hasProperty = !!acct?.property_status;
  const idOk = me?.identity_status === 'verified';       // photo ID (government ID + live selfie) must be verified first
  const paid = acct?.state === 'active' || acct?.state === 'grace';
  const room = (acct?.property_capacity ?? 1) > (acct?.property_count ?? 0);          // the plan has room for another property in THIS account (Max)
  const addHere = paid && (!hasProperty || room);                                       // paid, and the property goes straight into this account
  const [f, setF] = useState<PropertyDraft>(getPropertyDraft() ?? EMPTY);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [code, setCode] = useState('');
  const set = <K extends keyof PropertyDraft>(k: K) => (v: PropertyDraft[K]) => setF({ ...f, [k]: v });
  const body = () => ({ name: f.name || null, address: f.address, city: f.city, state: f.state || null, pincode: f.pincode, kind: f.kind,
                        proof_type: f.proofType, proof_ref: f.proofRef, declare: f.declare });
  const complete = f.address.trim().length >= 5 && f.city.trim().length >= 2 && /^[1-9]\d{5}$/.test(f.pincode) && f.proofRef.trim().length >= 6 && f.declare;

  async function go() {
    setTouched(true); setErr(null);
    if (!complete) return;
    if (!idOk) { router.push('/(onboarding)/identity'); return; }
    setBusy(true);
    try {
      // 1. check everything first (format, ownership proof, already registered?) — nothing is stored and nothing is charged yet
      await api('/api/v1/owner/properties/check', { ownerAccount: owner, body: body() });
      if (addHere) {                       // this account is paid and empty: the property goes straight in
        await api('/api/v1/owner/properties', { ownerAccount: owner, body: { ...body(), otp_code: code } });
        setPropertyDraft(null);
        await refresh(); qc.invalidateQueries();
        goBack();
        return;
      }
      setPropertyDraft(f);                              // 2. otherwise choose and pay a plan for it first (kept in memory only)
      if (hasProperty && !addHere) {                    // another property = its own account, its own plan
        // an account already started for this (still without a property) is reused, never a second empty one
        const started = me?.owner_accounts.find((o) => o.role === 'owner' && !o.property_status && o.owner_account_id !== owner);
        if (started) {
          selectOwner(started.owner_account_id);
          if (started.state === 'active' || started.state === 'grace') return;    // already paid: stay here and fill it in (save needs the code)
        } else {
          const w = await api<{ owner_account_id: string }>('/api/v1/owner/workspaces', { ownerAccount: owner, method: 'POST' });
          await refresh();
          selectOwner(w.owner_account_id);
        }
      }
      router.replace('/(onboarding)/plan');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }

  const kinds = [{ value: 'commercial', label: t('property.commercial'), icon: 'office-building-outline' }, { value: 'residential', label: t('property.residential'), icon: 'home-variant-outline' },
                 { value: 'mixed', label: t('property.mixed'), icon: 'home-city-outline' }];
  const proofs = [{ value: 'property_tax', label: t('property.pt_property_tax'), icon: 'receipt-text-outline' }, { value: 'sale_deed', label: t('property.pt_sale_deed'), icon: 'file-sign' },
                  { value: 'electricity_bill', label: t('property.pt_electricity_bill'), icon: 'flash-outline' }, { value: 'lease_deed', label: t('property.pt_lease_deed'), icon: 'file-document-outline' }];
  return (
    <Screen>
      <Text style={{ color: brand.muted, lineHeight: 22 }}>{t('property.intro')}</Text>
      <Panel title={t('property.photoId')} icon={idOk ? 'shield-check' : 'card-account-details-outline'} tone={idOk ? 'green' : 'amber'}>
        <Text style={{ lineHeight: 21, color: idOk ? brand.green600 : brand.ink, fontWeight: idOk ? '700' : '400' }}>{idOk ? t('property.photoIdDone') : t('property.photoIdNeeded')}</Text>
        {!idOk ? <AppButton icon="face-recognition" label={t('property.verifyPhotoId')} onPress={() => router.push('/(onboarding)/identity')} testID="verify-photo-id" /> : null}
      </Panel>
      <Panel title={t('property.title')} icon="home-city-outline" tone="teal">
        <Field label={t('property.name')} value={f.name} onChangeText={set('name')} kind="text" />
        <Field label={t('property.address')} value={f.address} onChangeText={set('address')} kind="address" multiline error={touched && f.address.trim().length < 5 ? t('error.required') : undefined} />
        <Field label={t('property.city')} value={f.city} onChangeText={set('city')} kind="text" error={touched && f.city.trim().length < 2 ? t('error.required') : undefined} />
        <Field label={t('property.state')} value={f.state} onChangeText={set('state')} kind="text" />
        <Field label={t('property.pincode')} value={f.pincode} onChangeText={(v) => set('pincode')(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6}
               kind="text" error={touched && !/^[1-9]\d{5}$/.test(f.pincode) ? t('error.required') : undefined} />
        <TabPills value={f.kind} onChange={(v) => set('kind')(v as PropertyDraft['kind'])} tabs={kinds} />
      </Panel>
      <Panel title={t('property.proofType')} icon="shield-check-outline" tone="green">
        <TabPills value={f.proofType} onChange={(v) => set('proofType')(v as PropertyDraft['proofType'])} tabs={proofs} />
        <Field label={t('property.proofRef')} value={f.proofRef} onChangeText={set('proofRef')} kind="text" maxLength={40}
               error={touched && f.proofRef.trim().length < 6 ? t('error.required') : undefined} />
      </Panel>
      <Pressable onPress={() => set('declare')(!f.declare)} accessibilityRole="checkbox" accessibilityState={{ checked: f.declare }}
                 style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 4 }}>
        <Icon source={f.declare ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={brand.teal700} />
        <Text style={{ flex: 1, lineHeight: 21 }}>{t('property.declare')}</Text>
      </Pressable>
      {addHere ? <ActionOtp action="property" code={code} onChange={setCode} ownerAccount={owner} /> : null}
      <ErrorBanner error={err} />
      {hasProperty && !addHere ? <Text style={{ color: '#B45309', lineHeight: 21 }}>{t('property.anotherNote')}</Text> : null}
      {(() => {
        // say why Save cannot be pressed yet, instead of a silently grey button
        const needCode = addHere && !otpReady(code);
        const msg = !idOk ? t('property.whyPhotoId') : !complete ? t('property.whyFields') : needCode ? t('property.whyCode') : null;
        return msg ? <Text style={{ color: '#B45309', fontWeight: '700', lineHeight: 21 }} accessibilityLiveRegion="polite" testID="why-disabled">{msg}</Text> : null;
      })()}
      <AppButton label={addHere ? t('property.save') : t('property.check')} icon="shield-check" loading={busy} disabled={busy || !idOk || (touched && !complete) || (addHere && !otpReady(code))} onPress={go} testID="check-property" />
    </Screen>
  );
}
