// Excel bulk onboarding: download template → pick file → row-level preview → commit valid rows.
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Icon, List, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { ErrorBanner, Screen } from '@/components/ui';
import { API_URL, api } from '@/lib/api';
import { Button } from '@/components/Buttons';
import { brand, radius, shadow } from '@/theme';
import { ownerAccountId, useAuth } from '@/lib/auth';

export default function ImportScreen() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const owner = ownerAccountId(me);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  async function pick() {
    const r = await DocumentPicker.getDocumentAsync({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', '*/*'], copyToCacheDirectory: true });
    if (r.canceled) return;
    const f = r.assets[0];
    const form = new FormData();
    form.append('file', { uri: f.uri, name: f.name, type: f.mimeType ?? 'application/octet-stream' } as any);
    setBusy(true); setErr(null); setResult(null);
    try { setPreview(await api('/api/v1/owner/imports', { form, ownerAccount: owner })); } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  async function commit() {
    setBusy(true);
    try { setResult(await api(`/api/v1/owner/imports/${preview.job_id}/commit`, { method: 'POST', ownerAccount: owner })); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <Pressable onPress={pick} disabled={busy} accessibilityRole="button" accessibilityLabel="Choose .xlsx" testID="choose-xlsx"
                 style={({ pressed }) => [{ alignItems: 'center', gap: 10, padding: 28, borderRadius: radius.lg, borderWidth: 2, borderStyle: 'dashed',
                   borderColor: brand.teal600, backgroundColor: pressed ? brand.teal100 : brand.teal50 }, shadow]}>
        <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: brand.green600, alignItems: 'center', justifyContent: 'center' }}>
          <Icon source="file-excel" size={34} color="#fff" />
        </View>
        <Text variant="titleMedium" style={{ fontWeight: '800', color: brand.teal700 }}>{busy ? '…' : 'Choose .xlsx File'}</Text>
        <Text variant="bodySmall" style={{ color: brand.muted }}>.xlsx</Text>
      </Pressable>
      <Button mode="outlined" icon="download" onPress={() => WebBrowser.openBrowserAsync(`${API_URL}/api/v1/owner/imports/template`)}>{t('owner.template')}</Button>
      <ErrorBanner error={err} />
      {preview ? (
        <>
          {preview.file_errors.map((e: any, i: number) => <Text key={i} style={{ color: 'crimson' }}>{JSON.stringify(e)}</Text>)}
          <Text>{`${preview.rows.filter((r: any) => r.valid).length}/${preview.rows.length} rows OK · new shops ${preview.new_units} · capacity left ${preview.remaining_capacity ?? 0}`}</Text>
          {preview.rows.map((r: any) => (
            <List.Item key={r.row} title={`Row ${r.row}: ${r.unit ?? ''} ${r.tenant ?? ''}`}
              description={r.errors.map((e: any) => `${e.field}: ${t(`error.${e.code}`, { defaultValue: e.code })}`).join(' · ') || 'OK'}
              left={(p) => <List.Icon {...p} icon={r.valid ? 'check' : 'alert-circle'} color={r.valid ? 'green' : 'crimson'} />} />
          ))}
          <Button mode="contained" disabled={!preview.can_commit || !!result || busy} onPress={commit}>{t('common.confirm')}</Button>
        </>
      ) : null}
      {result ? <Text accessibilityRole="alert">{`Imported ${result.imported}. Skipped ${result.failed.length}.`}</Text> : null}
    </Screen>
  );
}
