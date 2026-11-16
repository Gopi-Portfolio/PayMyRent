// "Scan ID or Agreement": a photo of a new renter's ID card, rent agreement or visiting card is read on the server, which suggests the renter's name and
// mobile number. The owner always checks them: they are put into the form, not saved. The photo is not kept (the server reads it and forgets it).
// Scanning needs the internet, so it is never saved for later: offline, the buttons say so and the details can simply be typed.
import * as ImagePicker from 'expo-image-picker';
import React from 'react';
import { View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { AppButton } from '@/components/Buttons';
import { api } from '@/lib/api';
import { useOnline } from '@/lib/network';
import { shrink } from '@/lib/photo';
import { brand, radius } from '@/theme';

export type ScanResult = { name: string | null; mobile: string | null; found: boolean };

export function RenterScan({ owner, onRead }: { owner?: string | null; onRead: (found: { name: string | null; mobile: string | null }) => void }) {
  const { t } = useTranslation();
  const online = useOnline();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);

  async function scan(source: 'camera' | 'gallery') {
    setNote(null);
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setNote({ text: t('docCheck.permission'), tone: 'warn' }); return; }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, allowsEditing: false };
    const picked = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (picked.canceled || !picked.assets?.[0]) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', { uri: await shrink(picked.assets[0]), name: 'renter.jpg', type: 'image/jpeg' } as any);
      const res = await api<ScanResult>('/api/v1/owner/renter-scan', { method: 'POST', form, ownerAccount: owner, timeoutMs: 60000 });
      if (!res.found) { setNote({ text: t('scan.nothing'), tone: 'warn' }); return; }
      onRead({ name: res.name, mobile: res.mobile });
      setNote({ text: res.name && res.mobile ? t('scan.found') : t('scan.foundSome'), tone: 'ok' });
    } catch (e: any) {
      setNote({ text: e?.message || t('scan.nothing'), tone: 'warn' });
    } finally { setBusy(false); }
  }

  return (
    <View style={{ backgroundColor: brand.teal50, borderRadius: radius.md, padding: 14, gap: 10 }} testID="renter-scan">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon source="line-scan" size={22} color={brand.teal700} />
        <Text style={{ flex: 1, fontWeight: '800', color: brand.ink }}>{t('scan.button')}</Text>
      </View>
      <Text style={{ color: brand.muted, lineHeight: 20, fontSize: 13 }}>{online ? t('scan.help') : t('scan.needsInternet')}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><AppButton variant="outline" compact icon="camera-outline" label={t('scan.camera')} disabled={!online || busy} onPress={() => scan('camera')} testID="scan-camera" /></View>
        <View style={{ flex: 1 }}><AppButton variant="outline" compact icon="image-outline" label={t('scan.photos')} disabled={!online || busy} onPress={() => scan('gallery')} testID="scan-gallery" /></View>
      </View>
      {busy ? <Text style={{ color: brand.teal700, fontWeight: '700' }} testID="scan-reading">{t('scan.reading')}</Text> : null}
      {note ? <Text style={{ color: note.tone === 'ok' ? brand.green600 : '#B45309', fontWeight: '700', lineHeight: 20 }} testID="scan-note">{note.text}</Text> : null}
    </View>
  );
}
