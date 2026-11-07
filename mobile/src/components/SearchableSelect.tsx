// Reusable searchable select in a bottom sheet. Used for every substantive picker (tenant, unit,
// language, charge type, state, city…). Keyboard and screen-reader accessible.
import React, { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text as RNText, View } from 'react-native';
import { Icon, Searchbar, Text, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';

export type Option<V extends string = string> = { value: V; label: string; subtitle?: string };

type Props<V extends string> = {
  label: string; value: V | null; options: Option<V>[]; onChange: (v: V) => void;
  error?: string; disabled?: boolean; testID?: string;
};

export function SearchableSelect<V extends string>({ label, value, options, onChange, error, disabled, testID }: Props<V>) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => `${o.label} ${o.subtitle ?? ''}`.toLowerCase().includes(n)) : options;
  }, [q, options]);

  return (
    <>
      {/* A fixed-height box: the label on top, the chosen option on ONE line below it. A long option ends with "…"; the box never grows. */}
      <Pressable onPress={() => !disabled && setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}: ${selected?.label ?? ''}`}
                 testID={testID} disabled={disabled}
                 style={[styles.box, { borderColor: error ? theme.colors.error : theme.colors.outline, backgroundColor: theme.colors.surface, opacity: disabled ? 0.5 : 1 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <RNText numberOfLines={1} style={{ fontSize: 12, color: error ? theme.colors.error : theme.colors.onSurfaceVariant }}>{label}</RNText>
          <RNText numberOfLines={1} ellipsizeMode="tail" style={{ fontSize: 16, color: theme.colors.onSurface, marginTop: 1 }}>{selected?.label ?? ' '}</RNText>
        </View>
        <Icon source="menu-down" size={26} color={theme.colors.onSurfaceVariant} />
      </Pressable>
      {error ? <Text style={{ color: theme.colors.error }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Pressable style={styles.backdrop} onPress={() => { setOpen(false); setQ(''); }} accessibilityLabel={t('common.cancel')} />
          <View style={[styles.sheet, { backgroundColor: theme.colors.surface }]}>
            <View style={styles.grab} />
            <Text variant="titleSmall" style={{ fontWeight: '800', marginBottom: 8, paddingHorizontal: 4 }}>{label}</Text>
            <Searchbar placeholder={t('common.search')} value={q} onChangeText={setQ} accessibilityLabel={t('common.search')} style={{ marginBottom: 8 }} />
            <FlatList
              data={filtered}
              keyExtractor={(o) => o.value}
              keyboardShouldPersistTaps="handled"
              style={{ flexGrow: 0 }}
              renderItem={({ item }) => (
                <Pressable onPress={() => { onChange(item.value); setOpen(false); setQ(''); }} accessibilityRole="button"
                           accessibilityState={{ selected: item.value === value }}
                           style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.colors.surfaceVariant }]}>
                  <Icon source={item.value === value ? 'check-circle' : 'circle-outline'} size={22} color={theme.colors.primary} />
                  <RNText numberOfLines={1} ellipsizeMode="tail" style={{ flex: 1, fontSize: 16, color: theme.colors.onSurface }}>{item.label}</RNText>
                  {item.subtitle ? <RNText numberOfLines={1} style={{ maxWidth: 110, fontWeight: '800', color: theme.colors.primary }}>{item.subtitle}</RNText> : null}
                </Pressable>
              )}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  box: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 8, borderWidth: 1, borderRadius: 12 },
  row: { height: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, borderRadius: 10 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { maxHeight: '75%', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 14, paddingBottom: 32 },
  grab: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: '#C5D2CE', marginBottom: 10 },
});
