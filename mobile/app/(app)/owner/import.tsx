// Excel bulk onboarding: download template → pick file → row-level preview → commit valid rows.
import * as DocumentPicker from 'expo-document-picker';
import * as WebBrowser from 'expo-web-browser';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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

  const ok = preview ? preview.rows.filter((r: any) => r.valid).length : 0;
  return (
    <Screen>
      {/* what this is for, who can use it, what it adds, what the file needs and why: before anything has to be done */}
      <View style={{ gap: 4 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: brand.ink }} accessibilityRole="header">{t('import.title')}</Text>
        <Text style={{ color: brand.muted, lineHeight: 21 }}>{t('import.intro')}</Text>
      </View>
      <InfoCard icon="account-check-outline" title={t('import.whoTitle')} testID="import-who"><Text style={styles.body}>{t('import.who')}</Text></InfoCard>
      <InfoCard icon="database-plus-outline" title={t('import.whatTitle')} testID="import-what"><Text style={styles.body}>{t('import.what')}</Text></InfoCard>
      <InfoCard icon="format-list-checks" title={t('import.needTitle')} testID="import-need">
        <Text style={styles.body}>{t('import.needRequired')}</Text>
        <Text style={[styles.body, { color: brand.muted }]}>{t('import.needOptional')}</Text>
      </InfoCard>
      <InfoCard icon="lightbulb-on-outline" title={t('import.whyTitle')} testID="import-why"><Text style={styles.body}>{t('import.why')}</Text></InfoCard>

      <Text variant="titleMedium" style={{ fontWeight: '800', marginTop: 4 }}>{t('import.stepsTitle')}</Text>
      <Step n={1} text={t('import.step1')}>
        <Button mode="outlined" icon="download" onPress={() => WebBrowser.openBrowserAsync(`${API_URL}/api/v1/owner/imports/template`)} testID="download-template">{t('import.downloadTemplate')}</Button>
      </Step>
      <Step n={2} text={t('import.step2')} />
      <Step n={3} text={t('import.step3')}>
        <Pressable onPress={pick} disabled={busy} accessibilityRole="button" accessibilityLabel={t('import.chooseFile')} testID="choose-xlsx"
                   style={({ pressed }) => [{ alignItems: 'center', gap: 6, padding: 18, borderRadius: radius.lg, borderWidth: 2, borderStyle: 'dashed',
                     borderColor: brand.teal600, backgroundColor: pressed ? brand.teal100 : brand.teal50 }]}>
          <Icon source="file-excel" size={30} color={brand.green600} />
          <Text variant="titleSmall" style={{ fontWeight: '800', color: brand.teal700 }}>{busy ? '…' : t('import.chooseFile')}</Text>
          <Text variant="bodySmall" style={{ color: brand.muted }}>.xlsx</Text>
        </Pressable>
      </Step>
      <Step n={4} text={t('import.step4')} />
      <Step n={5} text={t('import.step5')} />
      <Text variant="bodySmall" style={{ color: brand.muted, lineHeight: 19 }} testID="import-safe">{t('import.safe')}</Text>

      <ErrorBanner error={err} />
      {preview ? (
        <>
          {preview.file_errors.map((e: any, i: number) => <Text key={i} style={{ color: 'crimson' }}>{JSON.stringify(e)}</Text>)}
          <Text style={{ fontWeight: '700' }} testID="import-summary">{t('import.summary', { ok, total: preview.rows.length, units: preview.new_units, left: preview.remaining_capacity ?? 0 })}</Text>
          {preview.rows.map((r: any) => (
            <List.Item key={r.row} title={t('import.rowTitle', { row: r.row, unit: r.unit ?? '', renter: r.tenant ?? '' })}
              description={r.errors.map((e: any) => `${e.field}: ${t(`error.${e.code}`, { defaultValue: e.code })}`).join(' · ') || t('import.ready')}
              left={(p) => <List.Icon {...p} icon={r.valid ? 'check' : 'alert-circle'} color={r.valid ? brand.green600 : 'crimson'} />} />
          ))}
          <Button mode="contained" disabled={!preview.can_commit || !!result || busy} onPress={commit} testID="import-confirm">{t('common.confirm')}</Button>
        </>
      ) : null}
      {result ? <Text accessibilityRole="alert" style={{ fontWeight: '700' }}>{t('import.done', { imported: result.imported, skipped: result.failed.length })}</Text> : null}
    </Screen>
  );
}

/** A small white card: an icon, a short heading and the text under it. */
function InfoCard({ icon, title, children, testID }: { icon: string; title: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={[{ flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.md, padding: 14 }, shadow]} testID={testID}>
      <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: brand.teal100, alignItems: 'center', justifyContent: 'center' }}><Icon source={icon} size={22} color={brand.teal700} /></View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ fontWeight: '800', fontSize: 15, color: brand.ink }}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

/** One numbered step, with its button (if it has one) right under the words. */
function Step({ n, text, children }: { n: number; text: string; children?: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: brand.teal700, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        <Text style={{ color: '#fff', fontWeight: '800' }}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={{ lineHeight: 21, fontWeight: '600', color: brand.ink }}>{text}</Text>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ body: { lineHeight: 21, color: brand.ink } });
