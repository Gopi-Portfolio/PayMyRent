// "Excel" and "PDF" buttons for a report or statement. One tap downloads the file and opens the share sheet.
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { downloadReport, FileFormat } from '@/lib/download';
import { brand } from '@/theme';

export function DownloadButtons({ path, fileName, ownerAccount }: { path: string; fileName: string; ownerAccount?: string | null }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<FileFormat | null>(null);
  const [err, setErr] = useState('');
  const go = async (f: FileFormat) => {
    setBusy(f); setErr('');
    try { await downloadReport(path, f, fileName, ownerAccount); }
    catch (e) { setErr((e as Error)?.message || t('report.downloadFailed')); }
    finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button mode="outlined" icon="file-excel-outline" style={{ flex: 1 }} loading={busy === 'xlsx'} disabled={!!busy} onPress={() => go('xlsx')} testID="download-xlsx">{t('report.excel')}</Button>
        <Button mode="outlined" icon="file-pdf-box" style={{ flex: 1 }} loading={busy === 'pdf'} disabled={!!busy} onPress={() => go('pdf')} testID="download-pdf">{t('report.pdf')}</Button>
      </View>
      {err ? <Text variant="bodySmall" style={{ color: brand.red600 }}>{err}</Text> : null}
    </View>
  );
}
