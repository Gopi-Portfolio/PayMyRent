// Owner verification, two pages. Page 1: full name, ID proof (PAN card, or Aadhaar front + back: the address is read from the back and saved to the
// profile), the property document (type, number and its first and last page in one module) and a live selfie. Page 2: the signature page:
// "the documents I submitted are original", signed by typing the name. The server reads and compares everything (no person reviews anything).
// When it passes, the owner goes to the dashboard.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { SearchableSelect } from '@/components/SearchableSelect';
import { Segmented } from '@/components/Segmented';
import { SlotRow, UploadSlot } from '@/components/UploadSlot';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { shrink } from '@/lib/photo';
import { addressSchema, nameSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

type Kind = 'pan' | 'aadhaar' | 'aadhaar_back' | 'selfie' | 'deed_first' | 'deed_last';
const PROOF_TYPES = ['property_tax', 'electricity_bill', 'sale_deed', 'rent_agreement', 'gst', 'other'];     // labels: ownerDetails.doc_<type>
const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();
const hint = { fontSize: 12, lineHeight: 17, color: brand.muted } as const;

type Check = { code: string; ok: boolean; message: string };

export function OwnerDocumentCheck({ docs }: { docs: { items: { kind: Kind; uploaded: boolean }[]; verified: boolean } }) {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const owner = ownerAccountId(me);
  const uploaded = (k: Kind) => docs.items.find((i) => i.kind === k)?.uploaded ?? false;

  const [step, setStep] = useState<'details' | 'sign'>('details');
  const [idKind, setIdKind] = useState<'pan' | 'aadhaar'>(uploaded('aadhaar') && !uploaded('pan') ? 'aadhaar' : 'pan');      // PAN card OR Aadhaar card
  const [f, setF] = useState({ legal_name: me?.full_name ?? '', address: me?.address ?? '', proofType: 'sale_deed', proofRef: '' });
  const [fromCard, setFromCard] = useState<boolean | null>(null);       // true: the address was read from the Aadhaar back; false: it could not be read
  const [touched, setTouched] = useState(false);
  const [declare, setDeclare] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const needed: Kind[] = [...(idKind === 'pan' ? ['pan' as Kind] : ['aadhaar' as Kind, 'aadhaar_back' as Kind]), 'selfie', 'deed_first', 'deed_last'];
  const allUploaded = needed.every(uploaded);
  const e = {
    legal_name: nameSchema.safeParse(f.legal_name).success ? undefined : t('docCheck.enterName'),
    address: addressSchema.safeParse(f.address).success ? undefined : t('docCheck.enterAddress'),
    proofRef: f.proofRef.trim().length >= 3 ? undefined : t('docCheck.enterProofRef'),
  };
  const formOk = Object.values(e).every((x) => !x) && allUploaded;

  async function pick(kind: Kind, source: 'camera' | 'gallery') {
    setErr(null);
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr(new Error(t('docCheck.permission'))); return; }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsEditing: false,
      ...(kind === 'selfie' ? { cameraType: ImagePicker.CameraType.front } : {}) };
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled || !r.assets?.[0]) return;
    const form = new FormData();
    setBusy(kind); setChecks(null);
    try {
      form.append('file', { uri: await shrink(r.assets[0]), name: `${kind}.jpg`, type: 'image/jpeg' } as any);
      const res = await api<{ address?: string | null }>(`/api/v1/owner/documents/${kind}`, { method: 'PUT', form, ownerAccount: owner, timeoutMs: 120000 });
      if (kind === 'aadhaar_back') {            // the address printed on the back of the Aadhaar: filled in here, the owner can correct reading mistakes
        if (res.address) { setF((x) => ({ ...x, address: res.address as string })); setFromCard(true); } else setFromCard(false);
      }
      await qc.invalidateQueries({ queryKey: ['owner-docs', owner] });
    } catch (x) { setErr(x); } finally { setBusy(null); }
  }

  function toSignature() {
    setTouched(true);
    if (!formOk) return;
    setErr(null); setChecks(null); setStep('sign');
  }

  async function signAndSubmit() {
    if (!declare || !same(signature, f.legal_name)) return;
    setBusy('verify'); setErr(null); setChecks(null);
    try {
      const r = await api<{ status: string; checks: Check[] }>('/api/v1/owner/documents/verify', {
        method: 'POST', ownerAccount: owner, timeoutMs: 180000,
        body: { legal_name: f.legal_name, signature, address: f.address, proof_type: f.proofType, proof_ref: f.proofRef, declare } });
      setChecks(r.checks);
      if (r.status === 'verified') { await refresh(); await qc.invalidateQueries(); router.replace('/(app)/owner'); }
    } catch (x) { setErr(x); } finally { setBusy(null); }
  }

  // ───────── page 2: the signature page ─────────
  if (step === 'sign') {
    const mismatch = signature.trim().length > 0 && !same(signature, f.legal_name);
    return (
      <Screen>
        <Panel title={t('docCheck.signTitle')} icon="draw-pen">
          <Text style={{ fontWeight: '700' }}>{f.legal_name}</Text>
          <Text style={hint}>{t(idKind === 'pan' ? 'docCheck.pan' : 'docCheck.aadhaar')} · {t(`ownerDetails.doc_${f.proofType}`)}</Text>
          <Pressable onPress={() => setDeclare(!declare)} accessibilityRole="checkbox" accessibilityState={{ checked: declare }}
                     style={({ pressed }) => [{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: radius.md, backgroundColor: pressed ? brand.teal100 : brand.teal50 }]}>
            <Icon source={declare ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} color={brand.teal700} />
            <Text style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>{t('docCheck.declare')}</Text>
          </Pressable>
          <Field label={t('docCheck.signLabel')} value={signature} onChangeText={setSignature} kind="name" error={mismatch ? t('docCheck.signMismatch') : undefined} />
        </Panel>
        <ErrorBanner error={err} />
        {checks ? (
          <Panel title={t(checks.every((c) => c.ok) ? 'docCheck.passed' : 'docCheck.failed')} icon={checks.every((c) => c.ok) ? 'check-decagram' : 'alert-circle-outline'}>
            {checks.map((c) => (
              <View key={c.code} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                <Icon source={c.ok ? 'check' : 'close-circle'} size={18} color={c.ok ? brand.teal700 : '#B3261E'} />
                <Text style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>{c.message}</Text>
              </View>
            ))}
          </Panel>
        ) : null}
        <AppButton compact icon="draw" label={busy === 'verify' ? t('docCheck.checking') : t('docCheck.signSubmit')} loading={busy === 'verify'}
                   disabled={busy !== null || !declare || !same(signature, f.legal_name)} onPress={signAndSubmit} testID="doc-sign" />
        <AppButton compact variant="outline" icon="arrow-left" label={t('docCheck.back')} disabled={busy !== null} onPress={() => { setStep('details'); setChecks(null); }} testID="doc-back" />
        <Text style={hint}>{t('docCheck.triesNote')}</Text>
      </Screen>
    );
  }

  // ───────── page 1: details, ID proof, property document, selfie ─────────
  const slot = (kind: Kind, label: string) => (
    <UploadSlot key={kind} testID={kind} label={label} done={uploaded(kind)} busy={busy === kind} disabled={busy !== null} gallery={kind !== 'selfie'}      // the selfie: live camera only
                cameraLabel={t('docCheck.cameraShort')} galleryLabel={t('docCheck.galleryShort')} retakeLabel={t('docCheck.retake')} doneLabel={t('docCheck.uploaded')}
                onCamera={() => pick(kind, 'camera')} onGallery={() => pick(kind, 'gallery')} />
  );
  return (
    <Screen>
      <Text style={hint}>{t('docCheck.subtitle')}</Text>
      <Panel title={t('docCheck.details')} icon="account-outline">
        <Field label={t('profile.fullName')} value={f.legal_name} onChangeText={set('legal_name')} kind="name" error={touched ? e.legal_name : undefined} />
      </Panel>
      <Panel title={t('docCheck.idProof')} icon="card-account-details-outline">
        <Segmented testID="doc-id" value={idKind} onChange={(v) => { setIdKind(v as 'pan' | 'aadhaar'); setFromCard(null); }}
                   options={[{ value: 'pan', label: t('docCheck.pan') }, { value: 'aadhaar', label: t('docCheck.aadhaar') }]} />
        <SlotRow>
          {idKind === 'pan' ? slot('pan', t('docCheck.pan')) : <>{slot('aadhaar', t('docCheck.front'))}{slot('aadhaar_back', t('docCheck.backSide'))}</>}
        </SlotRow>
        <Text style={hint}>{t(idKind === 'pan' ? 'docCheck.hintPan' : 'docCheck.hintAadhaar')}</Text>
        <Field label={t('profile.address')} value={f.address} onChangeText={set('address')} kind="address" multiline error={touched ? e.address : undefined} />
        <Text style={hint}>{t(idKind === 'aadhaar' ? (fromCard === false ? 'docCheck.addressNotRead' : 'docCheck.addressFromCard') : 'docCheck.addressTyped')}</Text>
      </Panel>
      <Panel title={t('docCheck.propertyDocument')} icon="file-document-outline" tone="blue">
        <SearchableSelect label={t('ownerDetails.proofType')} value={f.proofType} options={PROOF_TYPES.map((v) => ({ value: v, label: t(`ownerDetails.doc_${v}`) }))} onChange={set('proofType')} />
        <Field label={t('ownerDetails.proofRef')} value={f.proofRef} onChangeText={set('proofRef')} maxLength={40} error={touched ? e.proofRef : undefined} />
        <SlotRow>{slot('deed_first', t('docCheck.firstPage'))}{slot('deed_last', t('docCheck.lastPage'))}</SlotRow>
        <Text style={hint}>{t('docCheck.hintDeed')}</Text>
      </Panel>
      <Panel title={t('docCheck.selfie')} icon="face-recognition">
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {slot('selfie', t('docCheck.selfie'))}
          <Text style={[hint, { flex: 1.4 }]}>{t('docCheck.hintSelfie')}</Text>
        </View>
      </Panel>
      <ErrorBanner error={err} />
      {touched && !formOk ? <Text style={{ color: '#B3261E', fontSize: 13 }}>{t('docCheck.incomplete')}</Text> : null}
      <AppButton compact icon="draw" label={t('docCheck.continueSign')} disabled={busy !== null} onPress={toSignature} testID="doc-continue" />
    </Screen>
  );
}

/** The documents the server says are uploaded; `enabled` is false (the endpoint answers 404) while the automatic check is switched off. */
export function useOwnerDocs() {
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  return useQuery({ queryKey: ['owner-docs', owner], retry: false,
    queryFn: async () => {
      try { return await api<any>('/api/v1/owner/documents', { ownerAccount: owner }); }
      catch (x: any) { if (x?.status === 404) return { enabled: false }; throw x; }
    } });
}
