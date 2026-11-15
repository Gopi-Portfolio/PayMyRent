// Owner verification, two pages. Page 1: name and property document, the ID photos (PAN card, or Aadhaar front + back: the address is read from the
// back and saved to the profile), a live selfie and the deed pages. Page 2: the signature page: "the documents I submitted are original", signed by
// typing the name. The server reads and compares everything (no person reviews anything). When it passes, the owner goes to the dashboard.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { SearchableSelect } from '@/components/SearchableSelect';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { addressSchema, nameSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

type Kind = 'pan' | 'aadhaar' | 'aadhaar_back' | 'selfie' | 'deed_first' | 'deed_last';
type Item = { kind: Kind; icon: string; title: string; hint: string; gallery: boolean };
const ID_ITEMS: Record<'pan' | 'aadhaar', Item[]> = {
  pan: [{ kind: 'pan', icon: 'card-account-details-outline', title: 'docCheck.pan', hint: 'docCheck.panHint', gallery: true }],
  aadhaar: [
    { kind: 'aadhaar', icon: 'card-account-details', title: 'docCheck.aadhaar', hint: 'docCheck.aadhaarHint', gallery: true },
    { kind: 'aadhaar_back', icon: 'card-account-details-outline', title: 'docCheck.aadhaarBack', hint: 'docCheck.aadhaarBackHint', gallery: true },
  ],
};
const OTHER_ITEMS: Item[] = [
  { kind: 'selfie', icon: 'face-recognition', title: 'docCheck.selfie', hint: 'docCheck.selfieHint', gallery: false },      // live camera only
  { kind: 'deed_first', icon: 'file-document-outline', title: 'docCheck.deedFirst', hint: 'docCheck.deedHint', gallery: true },
  { kind: 'deed_last', icon: 'file-sign', title: 'docCheck.deedLast', hint: 'docCheck.deedHint', gallery: true },
];
const PROOF_TYPES = ['property_tax', 'electricity_bill', 'sale_deed', 'rent_agreement', 'gst', 'other'];     // labels: ownerDetails.doc_<type>
const same = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

type Check = { code: string; ok: boolean; message: string };

/** A phone photo can be 24 megapixels and over 8 MB, which the server refuses (the phone then only sees "cannot reach the server").
 *  Scale it to 2000 px on the long side, which is plenty for reading text and faces, and send a JPEG of about 1 to 2 MB. */
async function shrink(asset: { uri: string; width?: number; height?: number }): Promise<string> {
  const ctx = ImageManipulator.manipulate(asset.uri);
  if ((asset.width ?? 0) >= (asset.height ?? 0)) { if ((asset.width ?? 0) > 2000) ctx.resize({ width: 2000 }); }
  else if ((asset.height ?? 0) > 2000) ctx.resize({ height: 2000 });
  const img = await ctx.renderAsync();
  return (await img.saveAsync({ compress: 0.8, format: SaveFormat.JPEG })).uri;
}

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
  const idItems = ID_ITEMS[idKind];
  const items = [...idItems, ...OTHER_ITEMS];
  const allUploaded = items.every((i) => uploaded(i.kind));
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
          <Text style={{ color: brand.muted }}>{t(idKind === 'pan' ? 'docCheck.pan' : 'docCheck.aadhaar')} · {t(`ownerDetails.doc_${f.proofType}`)}</Text>
          <Pressable onPress={() => setDeclare(!declare)} accessibilityRole="checkbox" accessibilityState={{ checked: declare }}
                     style={({ pressed }) => [{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: radius.md, backgroundColor: pressed ? brand.teal100 : brand.teal50 }]}>
            <Icon source={declare ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={brand.teal700} />
            <Text style={{ flex: 1 }}>{t('docCheck.declare')}</Text>
          </Pressable>
          <Field label={t('docCheck.signLabel')} value={signature} onChangeText={setSignature} kind="name" error={mismatch ? t('docCheck.signMismatch') : undefined} />
        </Panel>
        <ErrorBanner error={err} />
        {checks ? (
          <Panel title={t(checks.every((c) => c.ok) ? 'docCheck.passed' : 'docCheck.failed')} icon={checks.every((c) => c.ok) ? 'check-decagram' : 'alert-circle-outline'}>
            {checks.map((c) => (
              <View key={c.code} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
                <Icon source={c.ok ? 'check' : 'close-circle'} size={20} color={c.ok ? brand.teal700 : '#B3261E'} />
                <Text style={{ flex: 1 }}>{c.message}</Text>
              </View>
            ))}
          </Panel>
        ) : null}
        <AppButton icon="draw" label={busy === 'verify' ? t('docCheck.checking') : t('docCheck.signSubmit')} loading={busy === 'verify'}
                   disabled={busy !== null || !declare || !same(signature, f.legal_name)} onPress={signAndSubmit} testID="doc-sign" />
        <AppButton icon="arrow-left" label={t('docCheck.back')} disabled={busy !== null} onPress={() => { setStep('details'); setChecks(null); }} testID="doc-back" />
        <Text style={{ color: brand.muted, fontSize: 12 }}>{t('docCheck.triesNote')}</Text>
      </Screen>
    );
  }

  // ───────── page 1: details, ID photos, selfie, deed pages ─────────
  const uploadPanel = (it: Item) => (
    <Panel key={it.kind} title={t(it.title)} icon={it.icon}>
      <Text style={{ color: brand.muted }}>{t(it.hint)}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon source={uploaded(it.kind) ? 'check-circle' : 'circle-outline'} size={22} color={uploaded(it.kind) ? brand.teal700 : brand.muted} />
        <Text>{uploaded(it.kind) ? t('docCheck.uploaded') : t('docCheck.notUploaded')}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <AppButton icon="camera" label={t('docCheck.camera')} loading={busy === it.kind} disabled={busy !== null} onPress={() => pick(it.kind, 'camera')} testID={`doc-camera-${it.kind}`} />
        {it.gallery ? <AppButton icon="image" label={t('docCheck.gallery')} disabled={busy !== null} onPress={() => pick(it.kind, 'gallery')} testID={`doc-gallery-${it.kind}`} /> : null}
      </View>
    </Panel>
  );
  return (
    <Screen>
      <Text style={{ color: brand.muted }}>{t('docCheck.subtitle')}</Text>
      <Panel title={t('ownerDetails.title')} icon="account-check-outline">
        <Field label={t('ownerDetails.legalName')} value={f.legal_name} onChangeText={set('legal_name')} kind="name" error={touched ? e.legal_name : undefined} />
      </Panel>
      <Panel title={t('ownerDetails.proofType')} icon="file-document-check-outline" tone="blue">
        <SearchableSelect label={t('ownerDetails.proofType')} value={f.proofType} options={PROOF_TYPES.map((v) => ({ value: v, label: t(`ownerDetails.doc_${v}`) }))} onChange={set('proofType')} />
        <Field label={t('ownerDetails.proofRef')} value={f.proofRef} onChangeText={set('proofRef')} maxLength={80} error={touched ? e.proofRef : undefined} />
      </Panel>
      <Panel title={t('docCheck.idChoice')} icon="card-account-details-outline">
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(['pan', 'aadhaar'] as const).map((k) => (
            <Pressable key={k} onPress={() => { setIdKind(k); setFromCard(null); }} accessibilityRole="radio" accessibilityState={{ selected: idKind === k }} testID={`doc-id-${k}`}
                       style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius.md, backgroundColor: idKind === k ? brand.teal700 : brand.teal50 }}>
              <Text style={{ color: idKind === k ? '#fff' : brand.teal700, fontWeight: '700' }}>{t(k === 'pan' ? 'docCheck.pan' : 'docCheck.aadhaar')}</Text>
            </Pressable>
          ))}
        </View>
      </Panel>
      {idItems.map(uploadPanel)}
      <Panel title={t('profile.address')} icon="home-map-marker">
        <Text style={{ color: brand.muted }}>{t(idKind === 'aadhaar' ? (fromCard === false ? 'docCheck.addressNotRead' : 'docCheck.addressFromCard') : 'docCheck.addressTyped')}</Text>
        <Field label={t('profile.address')} value={f.address} onChangeText={set('address')} kind="address" multiline error={touched ? e.address : undefined} />
      </Panel>
      {OTHER_ITEMS.map(uploadPanel)}
      <ErrorBanner error={err} />
      {touched && !formOk ? <Text style={{ color: '#B3261E' }}>{t('docCheck.incomplete')}</Text> : null}
      <AppButton icon="draw" label={t('docCheck.continueSign')} disabled={busy !== null} onPress={toSignature} testID="doc-continue" />
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
