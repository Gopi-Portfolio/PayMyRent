// "Download as..." dropdown: opens in place (no pop-up) and lists the file formats; tapping one downloads straight away.
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ActivityIndicator, Icon, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

import { downloadReport, FileFormat } from '@/lib/download';
import { brand, radius } from '@/theme';

const OPTIONS: { format: FileFormat; icon: string; label: string }[] = [
  { format: 'csv', icon: 'file-delimited-outline', label: 'CSV' },
  { format: 'pdf', icon: 'file-pdf-box', label: 'PDF' },
];

export function FormatSelect({ label, path, fileName, formats = ['csv', 'pdf'], onError }: {
  label: string; path: string; fileName: string; formats?: FileFormat[]; onError?: (e: unknown) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<FileFormat | null>(null);
  const pick = async (f: FileFormat) => {
    setOpen(false); setBusy(f);
    try { await downloadReport(path, f, fileName); } catch (e) { onError?.(e); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 6 }} testID="format-picker">
      <Pressable onPress={() => setOpen(!open)} disabled={!!busy} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="format-dropdown"
                 accessibilityLabel={label}
                 style={{ height: 58, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1.5, borderColor: open ? brand.teal700 : brand.line }}>
        <Text variant="labelSmall" style={{ color: brand.muted }}>{t('report.chooseFormat')}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon source="download-outline" size={20} color={brand.teal700} />
          <Text numberOfLines={1} style={{ flex: 1, fontWeight: '700', color: brand.ink }}>{label}</Text>
          {busy ? <ActivityIndicator size={18} /> : <Icon source={open ? 'menu-up' : 'menu-down'} size={24} color={brand.teal700} />}
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: brand.line, overflow: 'hidden' }}>
          {OPTIONS.filter((o) => formats.includes(o.format)).map((o) => (
            <Pressable key={o.format} onPress={() => pick(o.format)} accessibilityRole="button" testID={`format-${o.format}`}
                       style={({ pressed }) => ({ height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, backgroundColor: pressed ? brand.teal50 : '#fff', borderBottomWidth: 1, borderBottomColor: brand.line })}>
              <Icon source={o.icon} size={20} color={brand.teal700} />
              <Text style={{ flex: 1, fontWeight: '600', color: brand.ink }}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
