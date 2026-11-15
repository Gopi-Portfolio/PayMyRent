// Automatic owner check: PAN card, live selfie and the first and last page of the property deed. The server reads and compares them
// (no person reviews anything) and answers with a list of checks; a failed one tells the owner what to retake.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { ErrorBanner, Field, Panel, Screen } from '@/components/ui';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { addressSchema, nameSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

type Kind = 'pan' | 'selfie' | 'deed_first' | 'deed_last';
const ITEMS: { kind: Kind; icon: string; title: string; hint: string; gallery: boolean }[] = [
  { kind: 'pan', icon: 'card-account-details-outline', title: 'docCheck.pan', hint: 'docCheck.panHint', gallery: true },
  { kind: 'selfie', icon: 'face-recognition', title: 'docCheck.selfie', hint: 'docCheck.selfieHint', gallery: false },      // live camera only
  { kind: 'deed_first', icon: 'file-document-outline', title: 'docCheck.deedFirst', hint: 'docCheck.deedHint', gallery: true },
  { kind: 'deed_last', icon: 'file-sign', title: 'docCheck.deedLast', hint: 'docCheck.deedHint', gallery: true },
];

type Check = { code: string; ok: boolean; message: string };

export function OwnerDocumentCheck({ docs }: { docs: { items: { kind: Kind; uploaded: boolean }[]; verified: boolean } }) {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const owner = ownerAccountId(me);
  const [name, setName] = useState(me?.full_name ?? '');
  const [address, setAddress] = useState(me?.address ?? '');
  const [declare, setDeclare] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const uploaded = (k: Kind) => docs.items.find((i) => i.kind === k)?.uploaded ?? false;
  const allUploaded = ITEMS.every((i) => uploaded(i.kind));
  const e = {
    name: nameSchema.safeParse(name).success ? undefined : t('docCheck.enterName'),
    address: addressSchema.safeParse(address).success ? undefined : t('docCheck.enterAddress'),
  };

  async function pick(kind: Kind, source: 'camera' | 'gallery') {
    setErr(null);
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setErr(new Error(t('docCheck.permission'))); return; }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsEditing: false,
      ...(kind === 'selfie' ? { cameraType: ImagePicker.CameraType.front } : {}) };
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled || !r.assets?.[0]) return;
    const form = new FormData();
    form.append('file', { uri: r.assets[0].uri, name: `${kind}.jpg`, type: 'image/jpeg' } as any);
    setBusy(kind); setChecks(null);
    try {
      await api(`/api/v1/owner/documents/${kind}`, { method: 'PUT', form, ownerAccount: owner, timeoutMs: 90000 });
      await qc.invalidateQueries({ queryKey: ['owner-docs', owner] });
    } catch (x) { setErr(x); } finally { setBusy(null); }
  }

  async function submit() {
    setTouched(true);
    if (e.name || e.address || !declare || !allUploaded) return;
    setBusy('verify'); setErr(null); setChecks(null);
    try {
      const r = await api<{ status: string; checks: Check[] }>('/api/v1/owner/documents/verify', {
        method: 'POST', ownerAccount: owner, timeoutMs: 180000, body: { legal_name: name, address, declare } });
      setChecks(r.checks);
      if (r.status === 'verified') { await refresh(); await qc.invalidateQueries(); router.replace('/'); }
    } catch (x) { setErr(x); } finally { setBusy(null); }
  }

  return (
    <Screen>
      <Text style={{ color: brand.muted }}>{t('docCheck.subtitle')}</Text>
      {ITEMS.map((it) => (
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
      ))}
      <Panel title={t('docCheck.details')} icon="account-check-outline">
        <Field label={t('docCheck.legalName')} value={name} onChangeText={setName} kind="name" error={touched ? e.name : undefined} />
        <Field label={t('docCheck.address')} value={address} onChangeText={setAddress} kind="address" multiline error={touched ? e.address : undefined} />
      </Panel>
      <Pressable onPress={() => setDeclare(!declare)} accessibilityRole="checkbox" accessibilityState={{ checked: declare }}
                 style={({ pressed }) => [{ flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: radius.md, backgroundColor: pressed ? brand.teal100 : brand.teal50 }]}>
        <Icon source={declare ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={brand.teal700} />
        <Text style={{ flex: 1 }}>{t('docCheck.declare')}</Text>
      </Pressable>
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
      <AppButton icon="shield-check" label={busy === 'verify' ? t('docCheck.checking') : t('docCheck.submit')} loading={busy === 'verify'}
                 disabled={busy !== null || !allUploaded || !declare} onPress={submit} testID="doc-verify" />
      <Text style={{ color: brand.muted, fontSize: 12 }}>{t('docCheck.triesNote')}</Text>
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
