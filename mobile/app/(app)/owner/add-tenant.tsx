// Add Renter: only who the renter is. Name, mobile and a photo ID are required; email and current address are optional.
// The ID photo is sent to the server, which keeps it encrypted (an Aadhaar has its first 8 digits hidden automatically). Rent and the place come later, on Allot Renter.
// Needs the internet (the photo is uploaded), so it is never saved for later. The phone's own "offline" guess is not used to block the buttons
// (it can be wrong on Wi-Fi): the request is simply tried, and if it really cannot reach the server the person is told.
import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import React, { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton, Button } from '@/components/Buttons';
import { RenterScan } from '@/components/RenterScan';
import { ErrorBanner, Field, Screen } from '@/components/ui';
import { uploadPart } from '@/lib/uploadPart';
import { api } from '@/lib/api';
import { ownerAccountId, useAuth } from '@/lib/auth';
import { cameraAllowed } from '@/lib/cameraAccess';
import { shrink } from '@/lib/photo';
import { mobileSchema, nameSchema } from '@/lib/validation';
import { brand, radius } from '@/theme';

export const ID_TYPES = ['aadhaar', 'pan', 'voter', 'driving', 'passport'] as const;
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? undefined : r.error!.issues[0].message);

export default function AddRenter() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const ver = me?.owner_accounts.find((o) => o.owner_account_id === owner)?.verification;
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', mobile: '', email: '', address: '' });
  const [idType, setIdType] = useState<(typeof ID_TYPES)[number] | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });

  const e = { name: firstError(nameSchema.safeParse(f.name)), mobile: firstError(mobileSchema.safeParse(f.mobile)),
              idType: idType ? undefined : 'required', photo: photo ? undefined : 'required', ok: ok ? undefined : 'required' };
  const valid = !Object.values(e).some(Boolean);

  async function pick(source: 'camera' | 'gallery') {
    setNote(null);
    if (source === 'camera' && !(await cameraAllowed())) return;       // the library needs no permission; a refused camera sends the person to Settings
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsEditing: false };
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled || !r.assets?.[0]) return;
    setPhoto(await shrink(r.assets[0]));
  }

  async function save() {
    setTouched(true);
    if (!valid || !idType || !photo) return;
    setBusy(true); setErr(null);
    try {
      const form = new FormData();
      form.append('name', f.name); form.append('phone', f.mobile); form.append('id_type', idType); form.append('keep_copy_ok', 'true');
      if (f.email.trim()) form.append('email', f.email.trim());
      if (f.address.trim()) form.append('address', f.address.trim());
      form.append('file', uploadPart(photo));
      const r = await api<{ id: string }>('/api/v1/owner/renters', { method: 'POST', form, ownerAccount: owner, timeoutMs: 60000 });
      qc.invalidateQueries({ queryKey: ['renters'] });
      router.replace({ pathname: '/(app)/owner/allot', params: { open: r.id } });         // next: give them a place
    } catch (x) { setErr(x); } finally { setBusy(false); }
  }

  if (me && (!ver || ver === 'rejected')) return <Redirect href="/(onboarding)/owner-details" />;
  return (
    <Screen>
      <View style={{ gap: 2 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{t('renter.title')}</Text>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('renter.intro')}</Text>
      </View>
      {/* a photo of the ID card or an agreement can fill in the name and mobile for the owner to check */}
      <RenterScan owner={owner} onRead={(r) => setF((x) => ({ ...x, name: r.name ?? x.name, mobile: r.mobile ?? x.mobile }))} />
      <Field label={t('tenancy.tenantName')} value={f.name} onChangeText={set('name')} kind="name" error={touched ? e.name : undefined} testID="renter-name" />
      <Field label={t('tenancy.tenantMobile')} value={f.mobile} onChangeText={set('mobile')} kind="mobile" error={touched ? e.mobile : undefined} testID="renter-mobile" />
      <Field label={`${t('common.email')} (${t('renter.optional')})`} value={f.email} onChangeText={set('email')} kind="email" testID="renter-email" />
      <Field label={`${t('renter.address')} (${t('renter.optional')})`} value={f.address} onChangeText={set('address')} kind="address" multiline lines={3} testID="renter-address" />

      <View style={{ gap: 8 }}>
        <Text style={{ fontWeight: '800', color: brand.ink }}>{t('renter.idType')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {ID_TYPES.map((k) => (
            <Pressable key={k} onPress={() => setIdType(k)} accessibilityRole="radio" accessibilityState={{ selected: idType === k }} testID={`id-type-${k}`}
                       style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.pill, borderWidth: 1.5, borderColor: idType === k ? brand.teal700 : brand.line,
                                backgroundColor: idType === k ? brand.teal700 : '#fff' }}>
              <Text style={{ fontWeight: '800', color: idType === k ? '#fff' : brand.ink }}>{t(`renter.id_${k}`)}</Text>
            </Pressable>
          ))}
        </View>
        {touched && e.idType ? <Text style={{ color: brand.red600 }}>{t('renter.idTypeRequired')}</Text> : null}
        {idType === 'aadhaar' ? <Text style={{ color: brand.muted, lineHeight: 20 }} testID="aadhaar-note">{t('renter.aadhaarNote')}</Text> : null}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontWeight: '800', color: brand.ink }}>{t('renter.idPhoto')}</Text>
        {photo ? <Image source={{ uri: photo }} style={{ width: '100%', height: 180, borderRadius: radius.md, backgroundColor: brand.teal50 }} resizeMode="contain" accessibilityLabel={t('renter.photoAdded')} testID="id-preview" /> : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}><AppButton variant="outline" compact icon="camera-outline" label={t('scan.camera')} disabled={busy} onPress={() => pick('camera')} testID="id-camera" /></View>
          <View style={{ flex: 1 }}><AppButton variant="outline" compact icon="upload" label={t('renter.upload')} disabled={busy} onPress={() => pick('gallery')} testID="id-upload" /></View>
        </View>
        {touched && e.photo ? <Text style={{ color: brand.red600 }}>{t('renter.photoRequired')}</Text> : null}
        <Text style={{ color: brand.muted, lineHeight: 20 }}>{t('renter.privateNote')}</Text>
        {note ? <Text style={{ color: '#B45309', fontWeight: '700' }}>{note}</Text> : null}
      </View>

      <Pressable onPress={() => setOk(!ok)} accessibilityRole="checkbox" accessibilityState={{ checked: ok }} testID="keep-copy"
                 style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Icon source={ok ? 'checkbox-marked' : 'checkbox-blank-outline'} size={26} color={ok ? brand.teal700 : brand.muted} />
        <Text style={{ flex: 1, color: brand.ink, lineHeight: 21 }}>{t('renter.consent')}</Text>
      </Pressable>
      {touched && e.ok ? <Text style={{ color: brand.red600 }}>{t('renter.consentRequired')}</Text> : null}

      <ErrorBanner error={err} />
      <Button mode="contained" onPress={save} loading={busy} disabled={busy} contentStyle={{ height: 52 }} testID="save-renter">{t('renter.save')}</Button>
    </Screen>
  );
}
